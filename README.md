# TacoPKPass — Apple Wallet Loyalty Card System

A loyalty stamp card for restaurants. Customers scan a QR code, register, and receive an Apple Wallet card that gets stamped after each purchase. Restaurant owners stamp cards and send push notifications from an admin dashboard.

---

## How it works

1. Restaurant displays a QR code (from `/admin/qr`)
2. Customer scans it → fills in name + email → `.pkpass` downloads to their iPhone → they tap to add it to Apple Wallet
3. After a purchase, the owner opens the admin panel, finds the customer, and taps **Add Stamp**
4. Apple Wallet on the customer's phone silently updates the card (stamp count goes up)
5. Owner can broadcast a message ("Today is taco day!") → all cardholders see a notification

---

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js 18+ | Runtime |
| Apple Developer account ($99/yr) | Required to sign PKPass files and send push notifications |
| A public HTTPS domain or ngrok | Apple Wallet must reach your server over HTTPS |

---

## Step 1 — Clone and install

```bash
git clone <your-repo-url>
cd TacoPKPass
npm install
```

---

## Step 2 — Get your Apple certificates

Follow the full guide in [`certs/README.md`](certs/README.md). Summary:

1. Create a **Pass Type ID** at [developer.apple.com](https://developer.apple.com) → Certificates, Identifiers & Profiles → Identifiers → Pass Type IDs
2. Generate a CSR in Keychain Access → request certificate from Apple
3. Download `pass.cer`, import it into Keychain, export as `pass.p12`
4. Convert to PEM files and place them in the `certs/` directory:

```bash
openssl pkcs12 -in pass.p12 -clcerts -nokeys -out certs/signerCert.pem
openssl pkcs12 -in pass.p12 -nocerts -out certs/signerKey.pem

# Download Apple's WWDR intermediate certificate
curl -O https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
openssl x509 -inform der -in AppleWWDRCAG4.cer -out certs/wwdr.pem

# The pass cert doubles as the APNs cert for wallet pushes
cp certs/signerCert.pem certs/apnCert.pem
cp certs/signerKey.pem  certs/apnKey.pem
```

---

## Step 3 — Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
PORT=3000

# Your public server URL — must be HTTPS (Apple Wallet requirement)
# For local testing use your ngrok URL (see Step 4)
BASE_URL=https://yourdomain.com

# From Apple Developer portal → Identifiers → Pass Type IDs
PASS_TYPE_ID=pass.com.yourrestaurant.loyalty

# 10-character Team ID from developer.apple.com → Account → Membership
TEAM_ID=YOURTEAMID

# Displayed on the card
ORG_NAME=Your Restaurant

# Certificate paths (relative to project root)
CERT_PATH=./certs/signerCert.pem
KEY_PATH=./certs/signerKey.pem
WWDR_PATH=./certs/wwdr.pem
CERT_PASSPHRASE=           # leave blank if you exported the key without a passphrase

APN_CERT_PATH=./certs/apnCert.pem
APN_KEY_PATH=./certs/apnKey.pem

# SQLite database file
DB_PATH=./loyalty.db

# Password for the admin panel — change this before going live
ADMIN_TOKEN=changeme123
```

---

## Step 4 — Expose your server (required for Apple Wallet)

Apple Wallet's web service calls only work over **HTTPS**. You have two options:

### Option A — Local testing with ngrok

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Copy the `https://....ngrok-free.app` URL into your `.env` as `BASE_URL`, then start the server.

> You must restart the server every time your ngrok URL changes, because `BASE_URL` is baked into each generated pass.

### Option B — Production VPS (recommended for real use)

1. Spin up a VPS (DigitalOcean Droplet, AWS EC2, Hetzner, etc.)
2. Point a domain at it and set up TLS with [Caddy](https://caddyserver.com) or Let's Encrypt + nginx
3. Set `BASE_URL=https://yourdomain.com` in `.env`
4. Run with a process manager (see Step 6)

---

## Step 5 — Run locally

```bash
node index.js
```

You should see:

```
[DB] Database initialised
[SERVER] Listening on http://localhost:3000
[SERVER] Registration page : http://localhost:3000/register
[SERVER] Admin dashboard   : http://localhost:3000/admin
```

Open the admin dashboard: `http://localhost:3000/admin?token=changeme123`

---

## Step 6 — Deploy to production

### Install on the server

```bash
# SSH into your server
ssh user@yourdomain.com

# Install Node.js (if not present)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone <your-repo-url> /opt/tacopkpass
cd /opt/tacopkpass
npm install --production

# Upload your .env and certs/ via scp (never commit these)
scp .env user@yourdomain.com:/opt/tacopkpass/.env
scp -r certs/ user@yourdomain.com:/opt/tacopkpass/certs/
```

### Run with PM2 (keeps it alive on reboot)

```bash
npm install -g pm2

cd /opt/tacopkpass
pm2 start index.js --name tacopkpass
pm2 save
pm2 startup   # follow the printed command to enable auto-start
```

Useful PM2 commands:

```bash
pm2 logs tacopkpass      # tail logs
pm2 restart tacopkpass   # restart after config changes
pm2 stop tacopkpass      # stop
```

### Reverse proxy with Caddy (easiest HTTPS)

Install Caddy and create `/etc/caddy/Caddyfile`:

```
yourdomain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
```

Caddy handles TLS automatically via Let's Encrypt.

---

## Step 7 — Print the QR code

Once the server is live, open the admin panel and go to **QR Code**:

```
https://yourdomain.com/admin/qr?token=YOUR_ADMIN_TOKEN
```

Print it and place it at the counter. Customers scan it with their iPhone camera.

---

## Admin dashboard

The admin dashboard is a web page built into the app. No separate installation needed — it runs at the same URL as everything else.

### Accessing it

```
https://yourdomain.com/admin
```

You will see a login screen. Enter the value of `ADMIN_TOKEN` from your `.env` file (default: `changeme123` — change this before going live).

> The dashboard works from any device with a browser — phone, tablet, laptop. You can open it on a phone behind the counter to stamp cards during service.

### What's on the dashboard

**Stats bar (top)**
Shows total customers, total stamps issued, total rewards earned, and active wallet devices — updates every 30 seconds automatically.

**Customer table (main panel)**
Lists every registered customer with:
- Name and email
- A visual row of 10 dots showing their current stamp progress (filled dots = stamped)
- The date they joined
- An **+ Stamp** button

Use the search box to filter by name or email when the list gets long.

**Send Notification (right panel)**
Type any message and tap **Send to All Devices**. Every customer who has the card in their Apple Wallet receives a lock-screen notification instantly. Examples:
- `Today is Taco Tuesday! 🌮 Get 2x stamps all day.`
- `We're closing early tonight at 9pm.`
- `Happy hour starts in 30 minutes!`

**Registration QR Code (right panel)**
Opens the printable QR code that customers scan to register. Print it and tape it to the counter or put it in a table stand.

---

## Day-to-day operation

### Stamping a card after a purchase

1. Open `https://yourdomain.com/admin` on any device (phone works fine)
2. Enter your admin token
3. Find the customer by name or email using the search box
4. Tap **+ Stamp** — a spinner appears, then a confirmation toast
5. The customer's Apple Wallet card updates automatically within seconds (Apple Wallet calls your server silently in the background)

### Sending a notification to all cardholders

1. Open the admin dashboard
2. Type your message in the **Send Notification** panel on the right
3. Tap **Send to All Devices** — you'll see how many devices received it
4. All customers with the card in their wallet see a lock-screen notification

---

## URL reference

| URL | Description |
|---|---|
| `/register` | Customer registration page (QR code target) |
| `/admin?token=TOKEN` | Admin dashboard |
| `/admin/qr?token=TOKEN` | Printable QR code |
| `/admin/customers?token=TOKEN` | Customer list (JSON) |
| `/admin/stamp/:id` | Add stamp (POST) |
| `/admin/notify` | Broadcast notification (POST) |
| `/health` | Server health check |
| `/v1/...` | Apple Wallet web service (called by iOS automatically) |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Pass won't install on iPhone | Check that `BASE_URL` is HTTPS and the certs are valid |
| Card doesn't update after stamp | Apple Wallet may take 1–2 minutes; check server logs for APNs errors |
| "certificate not found" error | Verify the paths in `.env` and that all `.pem` files exist in `certs/` |
| ngrok URL expired | Restart ngrok, update `BASE_URL` in `.env`, restart the server |
| Admin page shows 403 | Check that `ADMIN_TOKEN` in `.env` matches the `?token=` in the URL |
