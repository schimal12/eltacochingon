# Apple Wallet Certificates

This directory holds the PEM certificate files required to sign PKPass archives
and send APNs push notifications. **Never commit these files to version control.**

---

## What you need

| File            | Description                                      |
|-----------------|--------------------------------------------------|
| `signerCert.pem`| Pass Type Certificate (public cert)              |
| `signerKey.pem` | Pass Type Certificate private key                |
| `wwdr.pem`      | Apple WWDR intermediate CA certificate           |
| `apnCert.pem`   | APNs certificate for pass update pushes          |
| `apnKey.pem`    | APNs private key for pass update pushes          |

> For pass signing and pass-update push notifications, `apnCert.pem`/`apnKey.pem`
> are typically the **same** cert/key as `signerCert.pem`/`signerKey.pem` — the
> Pass Type certificate also doubles as the APNs certificate for that pass.

---

## Step-by-step instructions

### 1. Create a Pass Type ID

1. Go to [developer.apple.com](https://developer.apple.com) → **Certificates, Identifiers & Profiles**.
2. Click **Identifiers** → **+** → select **Pass Type IDs** → Continue.
3. Enter a description (e.g. "Restaurant Loyalty Card") and an identifier
   (e.g. `pass.com.yourrestaurant.loyalty`). Click Continue → Register.
4. Copy this identifier into your `.env` as `PASS_TYPE_ID`.

---

### 2. Generate a Certificate Signing Request (CSR)

On macOS:

1. Open **Keychain Access** → menu **Keychain Access → Certificate Assistant →
   Request a Certificate From a Certificate Authority…**
2. Enter your email and a common name (e.g. "Restaurant Loyalty Pass").
3. Select **Saved to disk** and click Continue. Save the `.certSigningRequest` file.

---

### 3. Create the Pass Type Certificate

1. In the Apple Developer portal, click your Pass Type ID → **Create Certificate**.
2. Upload the `.certSigningRequest` file.
3. Download the generated `pass.cer` file.
4. Double-click `pass.cer` to import it into Keychain Access.

---

### 4. Export as .p12

1. In **Keychain Access → My Certificates**, find the "Pass Type ID: …" certificate.
2. Expand it to show the private key. Select **both** the certificate and the key.
3. Right-click → **Export 2 items…** → save as `pass.p12`.
4. Set a passphrase (or leave blank; note it for your `.env` `CERT_PASSPHRASE`).

---

### 5. Convert to PEM files

```bash
# Extract the public certificate
openssl pkcs12 \
  -in pass.p12 \
  -clcerts -nokeys \
  -out certs/signerCert.pem \
  -passin pass:YOUR_P12_PASSPHRASE

# Extract the private key (you will be prompted to set a PEM passphrase,
# or add -nodes to output an unencrypted key)
openssl pkcs12 \
  -in pass.p12 \
  -nocerts \
  -out certs/signerKey.pem \
  -passin pass:YOUR_P12_PASSPHRASE \
  -passout pass:YOUR_PEM_PASSPHRASE

# Copy for APNs (pass cert also works for pass-update pushes)
cp certs/signerCert.pem certs/apnCert.pem
cp certs/signerKey.pem  certs/apnKey.pem
```

Update `.env`:
```
CERT_PATH=./certs/signerCert.pem
KEY_PATH=./certs/signerKey.pem
APN_CERT_PATH=./certs/apnCert.pem
APN_KEY_PATH=./certs/apnKey.pem
CERT_PASSPHRASE=YOUR_PEM_PASSPHRASE   # leave blank if -nodes was used
```

---

### 6. Download the WWDR Certificate

Apple's Worldwide Developer Relations Intermediate Certificate is required to
build the certificate chain inside each PKPass.

```bash
# Download the current WWDR G4 certificate (valid until 2030)
curl -O https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer

# Convert from DER to PEM
openssl x509 \
  -inform der \
  -in AppleWWDRCAG4.cer \
  -out certs/wwdr.pem
```

Update `.env`:
```
WWDR_PATH=./certs/wwdr.pem
```

---◊

### 7. Verify the certificate chain

```bash
openssl verify \
  -CAfile certs/wwdr.pem \
  certs/signerCert.pem
```

You should see `certs/signerCert.pem: OK`.

---

### 8. Configure your `.env`

```
TEAM_ID=YOURTEAMID          # 10-char Apple Team ID from the developer portal
PASS_TYPE_ID=pass.com.yourrestaurant.loyalty
BASE_URL=https://yourdomain.com  # must be HTTPS for Apple Wallet web service
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `passkit-generator` throws "certificate not found" | Check the paths in `.env` and that the files exist |
| Pass installs but won't update | Make sure `BASE_URL` is HTTPS and reachable by Apple |
| APNs push fails | Ensure `PASS_TYPE_ID` in `.env` matches the cert's Pass Type ID exactly |
| Wrong passphrase error | Re-export from Keychain or set `CERT_PASSPHRASE=` (empty) if the key is unencrypted |
