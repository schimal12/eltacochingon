# TacoPKPass — Apple Wallet Loyalty Card System

A digital stamp card for restaurants, built on Apple Wallet. Customers scan a QR code, register in English or Spanish, and get a loyalty card added to their iPhone. The restaurant owner runs everything else from a Spanish-language admin dashboard: stamping cards, broadcasting notifications, running promotions, and tracking who's dropped off.

Live at **https://eltacochingon.onrender.com**, deployed on [Render](https://render.com).

---

## How it works

1. The restaurant prints/displays the QR code shown at the site's root URL (`/`) — it points at `/register`.
2. A customer scans it, fills in their name and email (in English or Spanish), and downloads a signed `.pkpass` — Apple Wallet opens it and they tap **Add**.
3. After a purchase, staff opens `/admin`, finds the customer (by search, or by scanning their pass's QR code at `/admin/scan`), and taps **+ Sello**.
4. Apple Wallet on the customer's phone silently receives a push and re-fetches the card — the stamp count updates within seconds, no app open required.
5. On reaching the stamp goal, the card shows a "You won X!" banner as large overlay text on the pass, then resets to 0 on their next visit.
6. The owner can also broadcast a message ("¡Hoy es martes de tacos!") to every cardholder's lock screen at once.

---

## Features

- **Bilingual customer passes** — English/Spanish, auto-detected from the browser and toggleable at registration; every pass field, back-of-card link, and reward message is translated.
- **Configurable promotions** — the owner sets "Stamps Required" and "Reward" from the admin dashboard. Each customer snapshots the active promotion when they register, so changing it only affects new signups — existing cards keep the deal they signed up under. Full **promotion history** is logged, with one-click reuse of a past promotion.
- **Soft-delete with 7-day undo** — deleting a customer hides them immediately but keeps them recoverable for 7 days via a "Recently Deleted" panel with a one-click Restore (which reactivates their existing pass instantly, no re-registration needed). A background job permanently purges anything older than 7 days.
- **Detractor tracking** — if a customer removes the card from their Apple Wallet, it's flagged automatically (a stat card + a badge on their row in the admin table) so the owner can see who's dropped off.
- **QR scan-to-stamp** — staff can scan a customer's pass (its barcode encodes their serial number) at `/admin/scan` to jump straight to stamping them, instead of searching by name.
- **Broadcast notifications** — a message typed into the admin dashboard becomes a real lock-screen notification on every registered device.
- **Back-of-card links** — Instagram, phone number, and a Google Maps link, all owner-configurable via environment variables.
- **Admin dashboard** — fully in Spanish, mobile-friendly (tested against real iPhone viewports), persists the admin token across reloads (no re-entering it every time you background the tab).

---

## Architecture

| Layer | Technology |
|---|---|
| Server | Node.js + Express |
| Database | Render Managed Postgres |
| Pass generation/signing | [`passkit-generator`](https://github.com/alexandercerutti/passkit-generator) |
| Push notifications | [`node-apn`](https://github.com/node-apn/node-apn) against Apple's **production** APNs gateway (Wallet pass pushes have no sandbox environment) |
| QR codes | [`qrcode`](https://github.com/soldair/node-qrcode) |
| Hosting | Render (web service + managed Postgres) |

### Project structure

```
index.js                       App entry point — Express setup, startup, daily purge job
db/database.js                 All Postgres queries (customers, devices, settings, promotion history)
routes/register.js             Public landing page (/), registration page & handler (/register)
routes/wallet.js               Apple Wallet Web Service protocol (/v1/*)
routes/admin.js                Admin API (customers, stamps, settings, promotions, devices)
passes/passGenerator.js        Builds and signs the .pkpass for a given customer
passes/apnSender.js            Sends the silent "your pass changed" push via APNs
passes/loyalty.pass/           Pass template (pass.json + images)
public/register.html           Customer-facing registration form (EN/ES)
public/admin.html              Admin dashboard (Spanish)
public/scan.html               QR scan-to-stamp page for staff
certs/                         Apple certificates (gitignored — see certs/README.md)
```

---

## Apple Wallet Web Service protocol

Implemented in `routes/wallet.js`, under `/v1/*`:

| Endpoint | Called by Wallet when... |
|---|---|
| `POST /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber` | The pass is added to a device |
| `DELETE /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber` | The pass is removed from a device |
| `GET /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier` | Wallet checks which passes changed since a given time |
| `GET /v1/passes/:passTypeIdentifier/:serialNumber` | Wallet re-fetches the current pass content |
| `POST /v1/log` | Wallet reports client-side errors (logged, not acted on) |

**Important gotcha, already handled but worth knowing if you touch `passGenerator.js`:** the pass's `webServiceURL` must be the bare base URL, with **no** `/v1` suffix. Apple's Wallet client appends `/v1/devices/...` itself — the `v1` is Apple's own protocol version. Adding `/v1` in `webServiceURL` causes every real request to arrive as `/v1/v1/devices/...`, which silently 404s against these routes. This was debugged by adding request logging and inspecting real device traffic, not by reading Apple's docs — the docs are easy to misread here.

---

## Environment variables

See [`.env.example`](.env.example) for the full list with comments. Summary:

| Variable | Required | Purpose |
|---|---|---|
| `BASE_URL` | Yes | Public HTTPS URL of the server. Baked into every generated pass. |
| `DATABASE_URL` | Yes | Postgres connection string. |
| `PASS_TYPE_ID` | Yes | From Apple Developer → Identifiers → Pass Type IDs |
| `TEAM_ID` | Yes | Apple Developer Team ID |
| `ORG_NAME` | Yes | Restaurant name, shown on the pass and admin dashboard |
| `CERT_PATH`, `KEY_PATH`, `WWDR_PATH`, `CERT_PASSPHRASE` | Yes | Pass-signing certificate (see below) |
| `APN_CERT_PATH`, `APN_KEY_PATH` | Yes | Same Pass Type certificate, used again for push notifications |
| `ADMIN_TOKEN` | Yes | Password for `/admin` — change from the default before going live |
| `INSTAGRAM_URL`, `CONTACT_PHONE`, `MAPS_URL` | No | Back-of-card links; each has a hardcoded fallback if unset |
| `PORT` | No | Defaults to 3000 (Render sets this automatically) |

---

## Setup

### 1. Clone and install

```bash
git clone <this-repo-url>
cd TacoPKPass
npm install
```

### 2. Get your Apple certificates

Full guide in [`certs/README.md`](certs/README.md). Summary:

1. Create a **Pass Type ID** at [developer.apple.com](https://developer.apple.com) → Certificates, Identifiers & Profiles → Identifiers → Pass Type IDs
2. Generate a CSR in Keychain Access → request a certificate from Apple
3. Download `pass.cer`, import into Keychain, export as `pass.p12`
4. Convert to PEM and place under `certs/`:

```bash
openssl pkcs12 -in pass.p12 -clcerts -nokeys -out certs/signerCert.pem
openssl pkcs12 -in pass.p12 -nocerts -out certs/signerKey.pem

curl -O https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
openssl x509 -inform der -in AppleWWDRCAG4.cer -out certs/wwdr.pem

# The Pass Type certificate doubles as the APNs cert for Wallet pushes —
# there is no separate app push certificate needed.
cp certs/signerCert.pem certs/apnCert.pem
cp certs/signerKey.pem  certs/apnKey.pem
```

### 3. Set up the database

Provision a Postgres instance (Render Managed Postgres, or any Postgres 13+ works for local dev) and set `DATABASE_URL`. The app creates and migrates its own tables on startup — no manual schema step needed.

> **Free Render Postgres expires 30 days after creation.** Upgrade to a paid plan before then, or you'll lose all customer data. This is a Render platform limit, not something the app can work around.

### 4. Configure environment

```bash
cp .env.example .env
```

Fill in every value — see the [Environment variables](#environment-variables) table above.

### 5. Run locally

```bash
npm run dev    # auto-restarts on file changes
# or
npm start
```

```
[DB] Database initialised
[SERVER] Listening on http://localhost:3000
[SERVER] Registration page : http://localhost:3000/register
[SERVER] Admin dashboard   : http://localhost:3000/admin
```

Apple Wallet's web service calls require **HTTPS**, so a plain `http://localhost` server can't receive device registrations or push updates — use ngrok (or similar) and set `BASE_URL` to the tunnel URL for real end-to-end testing.

---

## Deployment (Render)

This app is deployed as two Render resources in the same project/environment:

1. **A Node web service**, connected to this GitHub repo with auto-deploy on push to `main`. Build command `npm install`, start command `node index.js`. Certificates are uploaded as Render **Secret Files** (mounted at `/etc/secrets/...`) rather than committed to the repo; point `CERT_PATH` etc. at those paths in the service's environment variables.
2. **A Render Managed Postgres** instance in the same region, wired to the web service via `DATABASE_URL` (use the **internal** connection string — same-region Render services don't need TLS and avoid the external network hop).

Both can be managed via the [Render CLI](https://render.com/docs/cli) (`render services`, `render postgres`, `render deploys`, `render logs --tail`) if you're scripting deploys or debugging without the dashboard.

---

## Admin dashboard

Open `/admin` and enter the `ADMIN_TOKEN` value. The token is remembered on that device (via local storage) — you won't be asked again unless you tap **Cerrar sesión** or the token is rejected.

**Estadísticas (stats bar)** — total customers, stamps issued, rewards earned, active Wallet devices, and how many customers have removed the card.

**Clientes (customer table)** — search by name/email; each row shows stamp progress, which promotion they're on, join date, and **+ Sello** / **Eliminar** actions. A row gets a 🚫 badge if that customer removed their Wallet pass.

**Enviar Notificación** — broadcast a message to every registered device's lock screen.

**Promoción** — set the current Stamps Required + Reward for new signups, and reuse any past promotion from the history list below it.

**Código QR de Registro** — links to the public landing page customers scan to sign up.

**Eliminados Recientemente** — customers deleted in the last 7 days, restorable with one tap.

---

## URL reference

| URL | Description |
|---|---|
| `/` | Public landing page with the registration QR code |
| `/register` | Customer registration form (EN/ES) |
| `/admin` | Admin dashboard |
| `/admin/scan` | QR scan-to-stamp page for staff |
| `/admin/customers` | Customer list (JSON, admin-auth) |
| `/admin/stamp/:id` | Add a stamp (POST, admin-auth) |
| `/admin/customer/:id` | Soft-delete a customer (DELETE, admin-auth) |
| `/admin/customer/:id/restore` | Undo a deletion within 7 days (POST, admin-auth) |
| `/admin/deleted-customers` | Recently-deleted list (JSON, admin-auth) |
| `/admin/customer-by-serial/:serialNumber` | Look up a customer by their pass's serial number — used by the scan-to-stamp flow (admin-auth) |
| `/admin/notify` | Broadcast a notification (POST, admin-auth) |
| `/admin/settings` | Get/set the current promotion (GET/POST, admin-auth) |
| `/admin/promotion-history` | Past promotions (JSON, admin-auth) |
| `/admin/devices` | Debug view of device registrations + cert file status (admin-auth) |
| `/health` | Server health check |
| `/v1/...` | Apple Wallet web service (called automatically by iOS) |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Pass won't install on iPhone | Check `BASE_URL` is HTTPS and the certs in `certs/` (or Render Secret Files) are valid and not expired |
| Card doesn't update after stamping | Check `/admin/devices` — if a customer has zero registered devices, their pass never completed Wallet's registration handshake and needs to be removed + re-added |
| Notifications work but show no message text | The lock-screen banner text only appears via the pass's "Info" back field changing — this is wired up already, but if you added a *new* dynamic field, it needs its own `changeMessage` template |
| "certificate not found" error | Verify the cert env var paths and that all `.pem` files actually exist there |
| Admin page shows "No autorizado" | `ADMIN_TOKEN` doesn't match what you entered — check the Render service's environment variables |
| Database connection errors locally | Check `DATABASE_URL`; if using Render Postgres from outside Render's network, you need the **external** connection string and the machine's IP added to the database's IP allow list |
