# Google Form → Map sync (Thai address)

This connects a **real Google Form** (separate from the website) to your Route
Optimizer map. When someone submits a Thai address, a pin appears on **every open
map in real time** — no manual entry.

```
 Google Form  ──submit──▶  Apps Script trigger  ──POST──▶  /api/form-submit
                                                              │ geocodes Thai address
                                                              │ broadcasts via Socket.IO
                                                              ▼
                                                      pin appears on all maps
```

The Thai address fields collected: ชื่อ (name), บ้านเลขที่, หมู่, ซอย, ถนน,
ตำบล/แขวง, อำเภอ/เขต, จังหวัด, รหัสไปรษณีย์.

---

## Step 1 — Set the form secret on your server (Render)

1. Open <https://dashboard.render.com> → your **tsp-route-optimizer** service
2. **Environment** tab → **Add Environment Variable**
   - Key: `FORM_SECRET`
   - Value: pick any long random string, e.g. `myFormSecret_8f3kZ9qL`
3. Save (Render redeploys automatically).

> If you skip this, the server uses the default `change-this-form-secret` —
> works, but anyone who guesses it could push pins. Setting your own is safer.

---

## Step 2 — Create the Google Form (Apps Script does it for you)

1. Go to <https://script.google.com> → **New project**
2. Delete the empty `Code.gs` content and paste **everything** from
   [`FormSetup.gs`](FormSetup.gs).
3. Edit the two CONFIG lines at the top:
   ```javascript
   var WEBHOOK_URL = 'https://YOUR-SITE.onrender.com/api/form-submit';
   var FORM_SECRET = 'myFormSecret_8f3kZ9qL';   // same value as Step 1
   ```
   Replace `YOUR-SITE` with your real Render subdomain (check the dashboard).
4. Click the function dropdown (top toolbar), choose **`createForm`**, press **Run**.
5. Google asks for permission the first time → **Review permissions** → choose your
   account → **Allow**. (It needs to create a form and call your webhook.)
6. Open **View → Logs** (or **Execution log**). You'll see:
   ```
   ✅ Form created and live-sync trigger installed.
   📋 SHARE THIS (fill-in URL): https://docs.google.com/forms/d/e/…/viewform
   ```
   That **fill-in URL** is your public form — share it / Bitly it.

---

## Step 3 — Test it

**Quick test (no form needed):** in Apps Script, run the **`testWebhook`** function.
The log should show `Status 200: {"ok":true,…}` and a pin should pop onto any open
map within a second.

**Real test:** open the form's fill-in URL, submit an address like:
- ชื่อ: `ร้านกาแฟ`
- อำเภอ/เขต: `เมืองจันทบุรี`
- จังหวัด: `จันทบุรี`
- รหัสไปรษณีย์: `22000`

Watch the pin appear on the map automatically.

---

## How well does the geocoding work?

Addresses are geocoded by **OpenStreetMap (Nominatim)**, restricted to Thailand.

- **Province + district + subdistrict + postcode** geocode reliably.
- **Exact house numbers** only resolve if OSM has that building — many rural Thai
  addresses don't, so the pin lands on the subdistrict/town centre instead.
- Both **Thai script** and **English transliteration** work.

For best accuracy, encourage submitters to fill จังหวัด (province) and อำเภอ
(district) at minimum.

---

## Responses are also saved to a Sheet (optional)

In the form editor → **Responses** tab → green **Sheets** icon → links every
submission to a Google Sheet, so you keep a full record alongside the live map
pins. (The map sync works with or without this.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Log shows `403 Invalid form secret` | `FORM_SECRET` in the script ≠ the one on Render. Make them identical. |
| Log shows `404 Address not found` | Address too vague — add province/district. |
| Nothing happens on submit | Re-run `createForm` to reinstall the trigger; check the webhook URL has no typo and ends in `/api/form-submit`. |
| Pin appears but in the wrong spot | OSM lacks that exact address; it fell back to the area centre. Add more detail. |
| First load of the site is slow | Render free tier sleeps after 15 min idle (~30 s cold start). Normal. |
