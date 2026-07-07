#!/bin/bash
# Provision eqms-geosurvey on Hostinger VPS (run as root on server)
set -euo pipefail

APP_DIR=/var/www/eqms-geosurvey
DB_NAME=eqms-geosurvey
DB_USER=geosurvey
DB_PASS="${GEOSURVEY_DB_PASSWORD:-eqms.MIS.12@}"

echo "=== Create database and user ==="
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres createdb "${DB_NAME}"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER \"${DB_USER}\" WITH PASSWORD '${DB_PASS}';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"${DB_NAME}\" TO \"${DB_USER}\";"

echo "=== App directory ==="
mkdir -p "${APP_DIR}"

echo "=== PM2 process (after git clone + npm install + build) ==="
echo "cd ${APP_DIR} && npm install && npm run build && npm run db:setup"
echo "pm2 start npm --name eqms-geosurvey-api --cwd ${APP_DIR} -- run start:api"
echo "pm2 save"

echo "=== Nginx ==="
echo "Copy deploy/nginx-geosurvey.conf to /etc/nginx/sites-available/geosurvey.eqmscl.com"
echo "ln -sf /etc/nginx/sites-available/geosurvey.eqmscl.com /etc/nginx/sites-enabled/"
echo "certbot --nginx -d geosurvey.eqmscl.com -d www.geosurvey.eqmscl.com"
echo "nginx -t && systemctl reload nginx"

echo "Done. Point geosurvey.eqmscl.com DNS A record to this server IP."
