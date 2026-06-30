/**
 * Google Apps Script — creates a Thai-address Google Form and live-syncs every
 * submission to your Route Optimizer map.
 *
 * SETUP (see SETUP.md for the full walkthrough):
 *   1. Edit the two CONFIG values below.
 *   2. Run createForm() once  → it builds the form and installs the sync trigger.
 *   3. Share the form URL printed in the execution log.
 *
 * Each submission is POSTed to your site's /api/form-submit webhook, which
 * geocodes the Thai address and drops a pin on every open map in real time.
 */

// ─── CONFIG — EDIT THESE TWO LINES ────────────────────────────────────────────
var WEBHOOK_URL = 'https://YOUR-SITE.onrender.com/api/form-submit'; // your deployed site + /api/form-submit
var FORM_SECRET = 'change-this-form-secret';                        // must match FORM_SECRET on the server
// ──────────────────────────────────────────────────────────────────────────────

// Thai address questions (Thai + English). Titles MUST match onFormSubmit below.
var Q = {
  name:     'ชื่อสถานที่ / Name',
  house_no: 'บ้านเลขที่ / House No.',
  moo:      'หมู่ที่ / Moo',
  soi:      'ซอย / Soi',
  road:     'ถนน / Road',
  tambon:   'ตำบล / แขวง  (Subdistrict)',
  amphoe:   'อำเภอ / เขต  (District)',
  province: 'จังหวัด  (Province)',
  postcode: 'รหัสไปรษณีย์  (Postal code)'
};

/**
 * Run this ONCE to create the form and install the sync trigger.
 */
function createForm() {
  var form = FormApp.create('ปักหมุดที่อยู่บนแผนที่ / Add Address to Map')
    .setDescription('กรอกที่อยู่แบบไทยเพื่อปักหมุดบนแผนที่อัตโนมัติ\n' +
                    'Fill in a Thai address and it will be plotted on the map automatically.')
    .setCollectEmail(false);

  form.addTextItem().setTitle(Q.name).setRequired(true);
  form.addTextItem().setTitle(Q.house_no);
  form.addTextItem().setTitle(Q.moo);
  form.addTextItem().setTitle(Q.soi);
  form.addTextItem().setTitle(Q.road);
  form.addTextItem().setTitle(Q.tambon);
  form.addTextItem().setTitle(Q.amphoe);
  form.addTextItem().setTitle(Q.province).setRequired(true);
  form.addTextItem().setTitle(Q.postcode);

  // Remove any old triggers, then install a fresh on-submit trigger.
  removeTriggers_();
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();

  Logger.log('───────────────────────────────────────────────');
  Logger.log('✅ Form created and live-sync trigger installed.');
  Logger.log('📋 SHARE THIS (fill-in URL): ' + form.getPublishedUrl());
  Logger.log('✏️  Edit URL:                ' + form.getEditUrl());
  Logger.log('🔗 Webhook target:           ' + WEBHOOK_URL);
  Logger.log('───────────────────────────────────────────────');
}

/**
 * Fired automatically on each form submission. POSTs the address to the webhook.
 */
function onFormSubmit(e) {
  var byTitle = {};
  var items = e.response.getItemResponses();
  for (var i = 0; i < items.length; i++) {
    byTitle[items[i].getItem().getTitle()] = items[i].getResponse();
  }

  var payload = {
    secret:   FORM_SECRET,
    name:     byTitle[Q.name]     || '',
    house_no: byTitle[Q.house_no] || '',
    moo:      byTitle[Q.moo]      || '',
    soi:      byTitle[Q.soi]      || '',
    road:     byTitle[Q.road]     || '',
    tambon:   byTitle[Q.tambon]   || '',
    amphoe:   byTitle[Q.amphoe]   || '',
    province: byTitle[Q.province] || '',
    postcode: byTitle[Q.postcode] || ''
  };

  var res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log('Webhook response (' + res.getResponseCode() + '): ' + res.getContentText());
}

/**
 * Manual test — sends one fake submission to the webhook without the form.
 * Handy to confirm the URL + secret are correct before sharing the form.
 */
function testWebhook() {
  var res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({
      secret: FORM_SECRET,
      name: 'ทดสอบ Test Pin',
      amphoe: 'Mueang Chanthaburi',
      province: 'Chanthaburi',
      postcode: '22000'
    }),
    muteHttpExceptions: true
  });
  Logger.log('Status ' + res.getResponseCode() + ': ' + res.getContentText());
}

function removeTriggers_() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(all[i]);
  }
}
