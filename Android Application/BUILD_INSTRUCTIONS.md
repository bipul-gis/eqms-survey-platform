# Build Instructions

Step-by-step playbook for taking the MAMATA Survey Android wrapper from "fresh checkout" to "installable APK on enumerator phones".

---

## 1. First-time setup (run once per machine)

### 1.1 Install prerequisites

| Tool | Version | Why | Install |
|---|---|---|---|
| Node.js | 18 LTS or newer | Runs Vite / Capacitor CLI | https://nodejs.org/ |
| JDK | 17 (LTS) | Gradle uses it to compile the native shell | https://adoptium.net/ — pick "Temurin 17 (LTS)" → MSI installer |
| Android Studio | latest | Bundles Android SDK + build-tools + AVD manager | https://developer.android.com/studio |

After installing Android Studio, **open it once**, accept the SDK license, let it install the default SDK platform. That populates `ANDROID_HOME` (usually `C:\Users\<you>\AppData\Local\Android\Sdk`).

Verify in PowerShell:
```powershell
node --version           # v18.x or newer
java -version            # 17.x
echo $env:ANDROID_HOME   # should print the SDK path
```

### 1.2 Bootstrap the Android project

From this folder:
```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The script:
- Runs `npm install` (Capacitor + plugins)
- Builds the parent React app (`../dist/`)
- Copies the build into `www/`
- Generates the `android/` native project (`npx cap add android`)
- Runs `npx cap sync android`

### 1.3 Whitelist Capacitor's origin in Firebase

The WebView serves the app from `https://localhost/`. Firebase Auth needs that origin allow-listed:

1. Firebase Console → your project → **Authentication** → **Settings** → **Authorized domains**
2. Make sure `localhost` is in the list (it's there by default)
3. No changes needed for Firestore — it reads the same `firestore.rules` as the web app

---

## 2. Build a debug APK (for testing)

Debug APKs are unsigned and you don't need a keystore — perfect for confirming things work on a real phone before going through the signing dance.

From `Android Application/`:

```powershell
npm run build:debug
```

What that does:
1. Rebuilds the parent web app (`../dist/`)
2. Copies `../dist` → `./www`
3. Runs `npx cap sync android`
4. Calls Gradle: `cd android && gradlew.bat assembleDebug`

Output:
```
android\app\build\outputs\apk\debug\app-debug.apk
```

Transfer that APK to an enumerator phone (WhatsApp, Drive, USB, QR code to a hosted URL, whatever) and tap to install.

> First install: Android shows "Install blocked — this source isn't trusted". Tap **Settings** → enable **Allow from this source** for whichever app brought the file (WhatsApp / Files / Chrome), then go back and tap **Install**.

---

## 3. Build a signed release APK (for distribution)

Release APKs are signed with a **keystore** that you generate once and reuse forever. Without signing, Android refuses to install over a previous install (you'd have to uninstall first every time).

### 3.1 Generate the keystore (one time, ever)

```powershell
# From the Android Application folder
keytool -genkey -v `
  -keystore mamata-survey.jks `
  -alias mamata `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000
```

You'll be prompted for:
- A keystore password (write it down)
- A key password (use the same as the keystore password to keep it simple)
- Your name / org / city / country (cosmetic, shows up in the cert)

> 🔥 **CRITICAL**: This `mamata-survey.jks` file is your app's master identity.
> - Back it up in **three** separate places (laptop, cloud drive, USB stick).
> - Lose it and you can never update existing installs. Everyone on the old version would have to uninstall and install a fresh "different" app under a new package id.
> - **Never commit it to git** — `.gitignore` already excludes `*.jks` / `*.keystore`.

### 3.2 Tell Gradle where the keystore lives

Create `android/keystore.properties`:

```properties
storeFile=../../mamata-survey.jks
storePassword=YourKeystorePasswordHere
keyAlias=mamata
keyPassword=YourKeyPasswordHere
```

Then edit `android/app/build.gradle` and add a signing config (Capacitor's template doesn't include one by default — paste this into the `android { }` block):

```groovy
android {
    // ... existing config ...

    signingConfigs {
        release {
            def ksPropsFile = rootProject.file('keystore.properties')
            if (ksPropsFile.canRead()) {
                def props = new Properties()
                props.load(new FileInputStream(ksPropsFile))
                storeFile     file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias      props['keyAlias']
                keyPassword   props['keyPassword']
            }
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

### 3.3 Build the release APK

```powershell
npm run build:release
```

Output:
```
android\app\build\outputs\apk\release\app-release.apk
```

That's the file you distribute to enumerators.

---

## 4. Distribute to enumerators (no Play Store)

### Option A — Direct file share (smallest team)
WhatsApp / Telegram / Drive the APK to each enumerator. They tap → install → done.

### Option B — Hosted download + QR code (recommended)
1. Upload `app-release.apk` to **Firebase Hosting** (same project you already use), or any HTTPS server you control.
   ```
   /downloads/mamata-survey-v1.0.0.apk
   ```
2. Generate a QR code pointing to that URL (any free generator works).
3. Print the QR + 1-line install instructions ("Scan, tap Install, allow from this source") and hand it to new enumerators.
4. When you publish a new version, just upload the new APK. Enumerators don't get notified automatically — see **Option C** for in-app updates.

### Option C — In-app update banner (best UX)
A 30-line patch you can add later: the app fetches a tiny JSON manifest from your server at startup, compares versions, and shows a "New version available — Tap to update" banner that opens the APK URL. Want me to add this when you're ready?

---

## 5. Iterate during development

For the inner-loop "edit web code → see change in WebView" cycle:

```powershell
# Option 1: rebuild + sync each time
npm run sync
npm run open                  # opens Android Studio, hit ▶ Run

# Option 2: live reload (best for UI tweaks)
npm run live
```

Live mode points the WebView at your Vite dev server over your local network — code edits in `../src/` hot-reload on the phone in real time. Needs the phone and your PC on the same Wi-Fi.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `[copy-web] ✖ Parent build not found at ../dist` | Run `npm run build:web` first (or just `npm run sync` which chains everything) |
| Gradle: `SDK location not found` | Set `ANDROID_HOME` env var to your SDK path; restart PowerShell |
| Gradle: `Unsupported class file major version 65` | You're on JDK 21+; install JDK 17 and point `JAVA_HOME` at it |
| "Install blocked" on phone but no "Allow" toggle visible | Long-press the APK → **Install** → opens a deeper Android dialog where the toggle lives |
| Firebase Auth: `auth/unauthorized-domain` | Add `localhost` to Firebase → Authentication → Settings → Authorized domains |
| Map tiles don't load | Check phone has internet — OSM tiles are fetched live, not bundled |
| GPS permission never prompts | First time only: uninstall the app, reinstall — Android caches the deny state |

---

## 7. Production checklist

Before handing the APK to real enumerators:

- [ ] Built with `npm run build:release` (signed, not debug)
- [ ] Keystore backed up in three places
- [ ] APK installed on a real Android phone and tested end-to-end:
  - [ ] Login works
  - [ ] Questionnaire list appears
  - [ ] Form fills + submits
  - [ ] Draft saves offline and syncs when back online
  - [ ] GPS capture works (permission prompt accepted)
  - [ ] Map shows ward boundaries + features
- [ ] Version code in `android/app/build.gradle` is incremented for each release (`versionCode 2`, `versionName "1.0.1"`)
- [ ] APK URL + QR code generated and tested
- [ ] Old version's keystore + APK archived (in case you need to roll back)
