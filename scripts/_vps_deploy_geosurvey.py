import paramiko
from pathlib import Path

HOST = "187.77.155.38"
USER = "root"
KEY_PATH = Path.home() / ".ssh" / "eqms_vps"
APP_DIR = "/var/www/eqms-geosurvey"
OUT = r"D:\Project 3 Drive\Personal Script\EQMS Geosurvey Platform\scripts\_vps_deploy_geosurvey.out.txt"

CMD = f"""
set -e
cd "{APP_DIR}"
echo '=== BEFORE ==='
git status -sb
git log -1 --oneline
echo '=== RESET TO ORIGIN/MAIN ==='
git fetch origin
git reset --hard origin/main
git clean -fd
echo '=== AFTER RESET ==='
git log -1 --oneline
git status -sb
echo '=== INSTALL ==='
npm install
echo '=== DB SETUP ==='
npm run db:setup || true
echo '=== BUILD ==='
npm run build
echo '=== PM2 ==='
pm2 restart eqms-geosurvey-api || pm2 start npm --name eqms-geosurvey-api --cwd "{APP_DIR}" -- run start:api
pm2 save
sleep 5
echo '=== HEALTH ==='
curl -sS -m 15 http://127.0.0.1:3002/api/health || true
echo
pm2 list
echo '=== PUBLIC ==='
curl -sS -m 15 -o /dev/null -w 'https://geosurvey.eqmscl.com -> %{{http_code}}\\n' https://geosurvey.eqmscl.com/ || true
echo '=== DONE ==='
git log -1 --oneline
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY_PATH))
client.connect(
    HOST,
    username=USER,
    pkey=pkey,
    timeout=20,
    allow_agent=False,
    look_for_keys=False,
)
stdin, stdout, stderr = client.exec_command(CMD, timeout=900)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
exit_status = stdout.channel.recv_exit_status()
with open(OUT, "w", encoding="utf-8") as f:
    f.write(out)
    if err:
        f.write("\nSTDERR:\n" + err)
    f.write(f"\nEXIT:{exit_status}\n")
client.close()
print("WROTE", OUT)
print("EXIT", exit_status)
