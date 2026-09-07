/**
 * 設定項目
 * ここに秘密の値(URL・メールアドレス等)を直接書かないこと。
 * 「スクリプトのプロパティ」(Apps Scriptエディタ → 歯車アイコン →
 * 「プロジェクトの設定」→「スクリプト プロパティ」)に登録して読み込む。
 *
 * 必要なプロパティ一覧:
 *   ADMIN_EMAIL          管理者(通知・BCC先)のメールアドレス
 *   SLACK_WEBHOOK_URL     Slack通知用のIncoming Webhook URL
 *   SLACK_MEMBER_ID       Slackでメンションする担当者のメンバーID
 *   SPREADSHEET_ID        注文台帳スプレッドシートのID(印鑑注文とは別の台帳でOK)
 *   SQUARE_ACCESS_TOKEN   Square APIのアクセストークン(Sandbox/本番共通の項目名。値を入れ替えて切り替える)
 *   SQUARE_LOCATION_ID    SquareのLocation ID
 *   SQUARE_API_BASE       'https://connect.squareupsandbox.com'(テスト) または
 *                          'https://connect.squareup.com'(本番)
 *   NOTION_API_KEY        Notion連携用インテグレーションのシークレット
 *
 * 印鑑販売フォーム(印鑑販売_行政書士様向け)と違い、フリーメイト印刷業者への
 * 発注ドラフト機能は使わないため PRINTER_EMAIL は不要。
 *
 * 画面(index.html)はGitHub Pages(../docs/)で配信し、このプロジェクトはdoPostで
 * 注文データを受け取るAPI専用の役割のみを持つ(印鑑販売フォームの「_API」版と同じ構成、
 * 2026-08-30にGitHub Pages化のため1プロジェクト完結型から変更)。
 */
const SCRIPT_PROPS = PropertiesService.getScriptProperties();
const ADMIN_EMAIL = SCRIPT_PROPS.getProperty('ADMIN_EMAIL');
const NOTIFICATION_URL = SCRIPT_PROPS.getProperty('SLACK_WEBHOOK_URL');
const SLACK_MEMBER_ID = SCRIPT_PROPS.getProperty('SLACK_MEMBER_ID');
const SPREADSHEET_ID = SCRIPT_PROPS.getProperty('SPREADSHEET_ID');
const SQUARE_ACCESS_TOKEN = SCRIPT_PROPS.getProperty('SQUARE_ACCESS_TOKEN');
const SQUARE_LOCATION_ID = SCRIPT_PROPS.getProperty('SQUARE_LOCATION_ID');
const SQUARE_API_BASE = SCRIPT_PROPS.getProperty('SQUARE_API_BASE') || 'https://connect.squareupsandbox.com';
const SS_URL = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/edit';

// このフォーム専用の注文台帳シート名。印鑑注文の台帳とは混在させない。
// シートが存在しない場合は自動でヘッダー行付きで作成する。
const ORDER_SHEET_NAME = '注文台帳_スタンプ_プルデンシャル';
const ORDER_SHEET_HEADERS = [
  '注文日時', '社名', '支店名', 'お名前', '郵便番号', '住所', '電話番号', 'FAX番号', '携帯電話番号', 'メールアドレス',
  '配送先郵便番号', '配送先住所', 'お届け先氏名', '配送先電話番号', '合計金額(税込)', '商品'
];
// ↑「支店名」列は2026-09-07にフォームから項目を削除したが、既存シートの列位置を保つため
// ヘッダー自体は残す(今後の注文は空欄になる。列を詰めると過去データの列がズレるため)。

// ===== Notion連携(注文後にDB_プロジェクト・DB_現金出納帳_F3へ自動記録) =====
// データソースIDは印鑑注文フォームと共通(同じNotionワークスペースのDB)。
const NOTION_VERSION = '2025-09-03';
const NOTION_DB_PROJECT_DATASOURCE_ID = '04875878-4070-47bb-85ab-fed881e7d7e4';
const NOTION_DB_CASHBOOK_DATASOURCE_ID = 'd5ba36f0-59e9-4377-b1ad-0cc43144afc5';
const NOTION_STAFF_SUGIKADO_ID = '196d872b-594c-8122-97f7-000281a411a0';

function _notionApiRequest(path, payload) {
  var token = SCRIPT_PROPS.getProperty('NOTION_API_KEY');
  if (!token) {
    console.error('スクリプトプロパティ「NOTION_API_KEY」が未設定のため、Notionへの記録をスキップしました');
    return null;
  }
  var res = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) {
    console.error('Notion APIエラー(' + path + '): ' + res.getContentText());
    return null;
  }
  return body;
}

// 注文をNotionのDB_プロジェクト(案件ページ)とDB_現金出納帳_F3(商品ごとの明細行)に記録する。
// 失敗しても注文自体(メール送信・決済)には影響させない。呼び出し側でtry/catchすること。
// (印鑑販売フォームの recordOrderToNotion_ と同じ実装パターン。案件名の接尾辞は選択された商品名)
function recordOrderToNotion_(formData, lineItems, orderDate, product) {
  var dateStr = Utilities.formatDate(orderDate, 'Asia/Tokyo', 'yyMMdd');
  var isoDate = Utilities.formatDate(orderDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  var projectTitle = dateStr + '_' + formData.userName + '_' + product.shortName;

  var projectPage = _notionApiRequest('pages', {
    parent: { type: 'data_source_id', data_source_id: NOTION_DB_PROJECT_DATASOURCE_ID },
    template: { type: 'default' },
    properties: {
      '案件名': { title: [{ text: { content: projectTitle } }] },
      '開始日': { date: { start: isoDate } },
      '担当者': { people: [{ id: NOTION_STAFF_SUGIKADO_ID }] },
      '進捗状況': { status: { name: '完了(クレジット)' } }
    }
  });
  if (!projectPage || !projectPage.id) return;

  // 作成直後の案件ページは、Notion側の検索インデックスが追いつかず、
  // 直後にリレーションで参照すると空のまま登録されてしまうことがある(実機テストで確認済み・2026-08-27)。
  // 少し待ってからリレーションを含む明細行を作成することで回避する。
  Utilities.sleep(1500);

  lineItems.forEach(function(item) {
    var qty = parseInt(item.quantity, 10) || 1;
    var unitPriceExcl = Math.round(item.base_price_money.amount / 1.1);
    _notionApiRequest('pages', {
      parent: { type: 'data_source_id', data_source_id: NOTION_DB_CASHBOOK_DATASOURCE_ID },
      properties: {
        '品目': { title: [{ text: { content: item.name } }] },
        '日付': { date: { start: isoDate } },
        '数量': { number: qty },
        '項目': { select: { name: '売上' } },
        '種別': { select: { name: '印鑑' } },
        '単価(税抜)': { number: unitPriceExcl },
        '課税対象': { select: { name: 'はい(10%)' } },
        'DB_プロジェクト': { relation: [{ id: projectPage.id }] }
      }
    });
  });
}

// ▼商品設定(価格は税込)。金額・商品を変更する場合はここだけ書き換えればよい。
// index.html側のJavaScript(PRODUCTS / SHIPPING_FEE)も表示用に同じ値を持っているので、
// 変更する場合は両方を合わせて変更すること。
// 2026-09-04 西元さんの指示: サンスタンパーA型を追加
// 2026-09-05 西元さんの指示: 両商品とも「送料込み・税込4,500円」に変更(送料の別建てをやめて価格に含める)
const PRODUCTS = {
  shiny: {
    shortName: 'シャイニースタンプ',                                   // メール件名・Slack・Notion案件名・台帳の「商品」列に使う
    name: 'シャイニースタンプ(プルデンシャル生命保険様)',              // Square決済・Notion「品目」に使う正式な商品名
    description: 'シャイニースタンプ（住所印／Shiny Printer S-844・22mm×58mm）', // 確認メール本文の商品説明
    price: 4500 // 税込・送料込み
  },
  sun: {
    shortName: 'サンスタンパー',
    name: 'サンスタンパー(プルデンシャル生命保険様)',
    description: 'サンスタンパー（住所印／A型・23mm×63mm）',
    price: 4500 // 税込・送料込み
  }
};
// 送料は商品価格に含めることになったため0円。復活させる場合はここに税込額を入れれば、
// Squareの明細・合計・Notion記帳に送料行が自動で戻る。
const SHIPPING_FEE = 0;

function toHalfWidth(str) {
  if (!str) return "";
  return String(str).replace(/[０-９]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
}

// 郵便番号はハイフンあり/なしどちらでも受け付ける。数字だけ取り出して「123-4567」形式に正規化する。
// 7桁に満たない場合(入力ミス等)は元の文字列をそのまま返す。
function formatZip_(raw) {
  var digits = toHalfWidth(raw || "").replace(/[^0-9]/g, "");
  if (digits.length !== 7) return toHalfWidth(raw || "").trim();
  return digits.substring(0, 3) + "-" + digits.substring(3);
}

// 画面(index.html)はGitHub Pagesで配信し、このプロジェクトはdoPostで
// 注文データを受け取るAPI専用の役割のみを持つ(印鑑注文フォームの「_API」版と同じ構成)。
// フォーム側はContent-Type: text/plainで送信し、プリフライト(OPTIONS)を発生させない。
function doPost(e) {
  var formData = JSON.parse(e.postData.contents);
  var result = processOrderForm(formData);
  var success = result.message.indexOf('エラー発生') !== 0;
  return ContentService.createTextOutput(JSON.stringify({ success: success, message: result.message, paymentUrl: result.paymentUrl }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Square注文明細(line_items)の1行を組み立てる。quantityは文字列で渡す仕様。
function _sqLineItem(name, quantity, unitPrice) {
  return { name: name, quantity: String(quantity), base_price_money: { amount: unitPrice, currency: 'JPY' } };
}

// Squareの決済リンク(Payment Links API)を、商品明細つきの注文(order)として作成する。
// 手数料は自社負担のため、各明細の金額はそのまま課金する(上乗せしない)。
// JPYは補助単位を持たないため、amountはそのまま円の整数値でよい。
// (印鑑販売フォームと全く同じ実装。そのまま流用)
function createSquarePaymentLink(lineItems, customerName) {
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
    console.error('Square未設定: SQUARE_ACCESS_TOKENまたはSQUARE_LOCATION_IDが未設定です');
    return null;
  }
  var payload = {
    idempotency_key: Utilities.getUuid(),
    order: {
      location_id: SQUARE_LOCATION_ID,
      reference_id: customerName,
      line_items: lineItems
    }
  };
  var res = UrlFetchApp.fetch(SQUARE_API_BASE + '/v2/online-checkout/payment-links', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + SQUARE_ACCESS_TOKEN, 'Square-Version': '2025-01-23' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (body.payment_link && body.payment_link.url) {
    return body.payment_link.url;
  }
  console.error('Square決済リンク作成失敗: ' + res.getContentText());
  return null;
}

// 注文台帳シートを取得する。存在しない場合はヘッダー行つきで新規作成する
// (このフォーム専用のシートなので、印鑑注文の台帳と混在しない)。
function getOrCreateOrderSheet_(ss) {
  var sheet = ss.getSheetByName(ORDER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ORDER_SHEET_NAME);
    sheet.appendRow(ORDER_SHEET_HEADERS);
    return sheet;
  }
  // 「商品」列を後から追加した(2026-09-04)ため、既存シートのヘッダーが古い場合は1行目を書き直して揃える
  if (sheet.getLastColumn() < ORDER_SHEET_HEADERS.length) {
    sheet.getRange(1, 1, 1, ORDER_SHEET_HEADERS.length).setValues([ORDER_SHEET_HEADERS]);
  }
  return sheet;
}

// 初回セットアップ用: 注文台帳スプレッドシートをまだ用意していない場合、
// Apps Scriptエディタでこの関数を選択して「実行」ボタンを押すだけで、
// 新しいスプレッドシートを作成し、SPREADSHEET_IDスクリプトプロパティに自動設定する。
// (SPREADSHEET_IDが既に設定済みの場合は何もしない。実行後はページを再読み込み/再デプロイ不要で、
//  次回のdoPost実行から新しいスプレッドシートが使われる)
function setupCreateOrderSpreadsheet() {
  var existing = SCRIPT_PROPS.getProperty('SPREADSHEET_ID');
  if (existing) {
    Logger.log('SPREADSHEET_IDは既に設定済みです(' + existing + ')。作り直す場合は先にスクリプトプロパティから削除してから再実行してください。');
    return;
  }
  var ss = SpreadsheetApp.create('注文台帳_スタンプ_プルデンシャル');
  getOrCreateOrderSheet_(ss);
  var defaultSheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (defaultSheet) ss.deleteSheet(defaultSheet);
  SCRIPT_PROPS.setProperty('SPREADSHEET_ID', ss.getId());
  Logger.log('スプレッドシートを作成し、SPREADSHEET_IDを設定しました: ' + ss.getUrl());
}

function processOrderForm(formData) {
  // 安全のためログに全データを記録
  console.log("送信データ: " + JSON.stringify(formData));

  try {

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = getOrCreateOrderSheet_(ss);

  formData.tel = toHalfWidth((formData.tel || "").trim());
  formData.fax = toHalfWidth((formData.fax || "").trim());
  formData.mobile = toHalfWidth((formData.mobile || "").trim());
  formData.zipCode = formatZip_(formData.zipCode);
  formData.address = toHalfWidth((formData.address || "").trim());
  formData.companyName = (formData.companyName || "").trim();
  formData.branchName = (formData.branchName || "").trim();
  formData.userName = (formData.userName || "").trim();

  // 配送先が「上記と同じ」ならスタンプの彫刻情報(社名側の郵便番号・住所・名前)をそのまま配送先として使う。
  // チェックが外れている場合のみ、フォームから送られてきた配送先専用の項目を使う。
  var sameAsAbove = (formData.sameAsAbove === 'true' || formData.sameAsAbove === 'on');
  var shipZip, shipAddress, shipName, shipTel;
  if (sameAsAbove) {
    shipZip = formData.zipCode;
    shipAddress = formData.address;
    shipName = formData.userName;
    shipTel = formData.tel;
  } else {
    shipZip = formatZip_(formData.shipZip);
    shipAddress = toHalfWidth((formData.shipAddress || "").trim());
    shipName = (formData.shipName || "").trim();
    shipTel = toHalfWidth((formData.shipTel || "").trim());
  }

  // 選択された商品(shiny / sun)。productTypeが送られてこない場合(古いキャッシュの画面など)は
  // 従来からの単一商品だったシャイニースタンプとして扱う。
  var product = PRODUCTS[formData.productType] || PRODUCTS.shiny;

  // 送料が0円(商品価格に込み)の間は、Square明細・Notion記帳に送料行を作らない
  var lineItems = [_sqLineItem(product.name, 1, product.price)];
  if (SHIPPING_FEE > 0) {
    lineItems.push(_sqLineItem('送料', 1, SHIPPING_FEE));
  }
  var total = product.price + SHIPPING_FEE;

  sheet.appendRow([
    new Date(), formData.companyName, formData.branchName, formData.userName,
    formData.zipCode, formData.address, formData.tel, formData.fax || "-", formData.mobile || "-", formData.email,
    shipZip, shipAddress, shipName, shipTel, total, product.shortName
  ]);

  var paymentUrl = createSquarePaymentLink(lineItems, formData.userName);

  try {
    recordOrderToNotion_(formData, lineItems, new Date(), product);
  } catch (notionErr) {
    console.error('Notion記録でエラー: ' + notionErr.toString());
  }

  sendOrderEmails(formData, product, total, sameAsAbove, shipZip, shipAddress, shipName, shipTel, paymentUrl);
  return { message: "ご注文を承りました。内容確認のメールをお送りしました。", paymentUrl: paymentUrl };

  } catch (e) {
    console.error(e.toString());
    return { message: "エラー発生: " + e.toString(), paymentUrl: null };
  }
}

function sendOrderEmails(data, product, total, sameAsAbove, shipZip, shipAddress, shipName, shipTel, paymentUrl) {
  var subject = "【ご注文受付】" + product.shortName + " - " + data.userName + "様（合計：" + total.toLocaleString() + "円）";

  var engraveDetails = "■スタンプ彫刻内容\n" +
                        "社名：" + data.companyName + "\n" +
                        "お名前：" + data.userName + "\n" +
                        "郵便番号：" + data.zipCode + "\n" +
                        "住所：" + data.address + "\n" +
                        "電話番号：" + data.tel + "\n" +
                        (data.fax ? "FAX番号：" + data.fax + "\n" : "") +
                        (data.mobile ? "携帯電話番号：" + data.mobile + "\n" : "") +
                        "\n";

  var shipDetails = "■お届け先\n" +
                     (sameAsAbove ? "（上記の彫刻内容と同じ送り先です）\n" : "") +
                     "〒" + shipZip + "\n" + shipAddress + "\n" + shipName + " 様\n" +
                     "電話番号：" + shipTel + "\n\n";

  var body = data.userName + " 様\n\nご注文ありがとうございます。\n\n" +
             "【ご注文商品】" + product.description + "\n" +
             "【合計金額】" + total.toLocaleString() + "円（税込・送料込み）\n" +
             "【納期】ご注文確認後、7営業日以内に発送\n\n" +
             engraveDetails + shipDetails;

  body += paymentUrl
    ? "【お支払い】\n下記のリンクからクレジットカードでお支払いください。\n" + paymentUrl + "\n\n"
    : "【お支払い】\n決済リンクの発行に失敗しました。お手数ですが担当者からのご連絡をお待ちください。\n\n";

  body += "内容に間違いがございましたら、このメールにご返信ください。\n";

  GmailApp.sendEmail(data.email, subject, body, { from: ADMIN_EMAIL, bcc: ADMIN_EMAIL });

  // Slack通知（担当者への個人メンション付き）。誰が何を注文したか一目でわかる内容にする。
  var mention = "<@" + SLACK_MEMBER_ID + ">";
  var slackText = mention + " *【" + product.shortName + "の注文が入りました（プルデンシャル生命保険様）】*\n\n" +
                  "*■基本情報*\n" +
                  "・注文者: " + data.userName + " 様（" + data.companyName + "）\n" +
                  "・商品: " + product.description + "\n" +
                  "・合計金額: " + total.toLocaleString() + "円 (税込・送料込)\n\n" +
                  "*■彫刻内容*\n" +
                  "社名：" + data.companyName + " / お名前：" + data.userName + "\n" +
                  "住所：〒" + data.zipCode + " " + data.address + "\n" +
                  "TEL：" + data.tel + (data.fax ? " / FAX：" + data.fax : "") + (data.mobile ? " / 携帯：" + data.mobile : "") + "\n\n" +
                  "*■お届け先*\n" +
                  (sameAsAbove ? "彫刻内容と同じ\n" : "〒" + shipZip + " " + shipAddress + "\n" + shipName + " 様 / TEL：" + shipTel + "\n") +
                  "\n詳細: <" + SS_URL + "|スプレッドシートを確認>";

  UrlFetchApp.fetch(NOTIFICATION_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ text: slackText })
  });
}

// ===== 注文とSquare決済の照合(2026-09-06追加) =====
// このフォームは「注文確定」の時点でNotion記帳・メール・Slack通知を行い、Square決済は
// お客様がリンク先で支払いを完了して初めて成立する。つまり支払いが完了しなくても
// 注文記録自体は残るため、実際に支払われたかどうかは別途Squareに問い合わせる必要がある。
//
// 呼び出し方(社外に公開しないURLなので、初回アクセス時に指定したkeyがそのまま合言葉として
// スクリプトプロパティ「RECONCILE_KEY」に保存される。以降はそのkeyと一致しないと動かない):
//   ?action=reconcile&days=7&key=<好きな合言葉>
function doGet(e) {
  var params = (e && e.parameter) || {};
  var storedKey = SCRIPT_PROPS.getProperty('RECONCILE_KEY');
  if (!storedKey) {
    if (!params.key) {
      return ContentService.createTextOutput(JSON.stringify({ error: '初回アクセスにはkeyパラメータが必要です' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    SCRIPT_PROPS.setProperty('RECONCILE_KEY', params.key);
    storedKey = params.key;
  }
  if (params.key !== storedKey) {
    return ContentService.createTextOutput(JSON.stringify({ error: '合言葉が一致しません' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'reconcile') {
    var days = parseInt(params.days, 10) || 7;
    return ContentService.createTextOutput(JSON.stringify(reconcilePayments_(days)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'cleanup_blank_rows') {
    return ContentService.createTextOutput(JSON.stringify(cleanupBlankNameRows_()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'delete_by_name' && params.name) {
    return ContentService.createTextOutput(JSON.stringify(deleteRowsByName_(params.name)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 過去{days}日分の注文台帳の各行と、Squareの注文(Orders Search API)を突き合わせる。
// 突き合わせキーは「お名前」(Square側はcreateSquarePaymentLinkでreference_idに設定している)と
// 金額。同姓同名が複数回注文した場合などは自動判定できないため要目視確認としてマークする。
function reconcilePayments_(days) {
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
    return { error: 'SQUARE_ACCESS_TOKENまたはSQUARE_LOCATION_IDが未設定です' };
  }
  var since = new Date();
  since.setDate(since.getDate() - days);

  // 1. こちらの注文台帳から対象期間の行を集める
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = getOrCreateOrderSheet_(ss);
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var idxDate = header.indexOf('注文日時');
  var idxName = header.indexOf('お名前');
  var idxTotal = header.indexOf('合計金額(税込)');
  var orders = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var orderDate = row[idxDate];
    if (!(orderDate instanceof Date) || orderDate < since) continue;
    orders.push({ date: orderDate, name: row[idxName], total: row[idxTotal] });
  }

  // 2. Square側の注文を同期間ぶん取得(Orders Search API)
  var res = UrlFetchApp.fetch(SQUARE_API_BASE + '/v2/orders/search', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + SQUARE_ACCESS_TOKEN, 'Square-Version': '2025-01-23' },
    payload: JSON.stringify({
      location_ids: [SQUARE_LOCATION_ID],
      query: {
        filter: { date_time_filter: { created_at: { start_at: since.toISOString() } } },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
      },
      limit: 100
    }),
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) {
    return { error: 'Square Orders Search APIエラー: ' + res.getContentText() };
  }
  var squareOrders = body.orders || [];

  // 3. お名前(reference_id)+金額で突き合わせ
  var results = orders.map(function(order) {
    var matches = squareOrders.filter(function(so) {
      return so.reference_id === order.name;
    });
    var match = matches.length === 1 ? matches[0] : null;
    var paid = match && match.tenders && match.tenders.length > 0;
    return {
      注文日時: Utilities.formatDate(order.date, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
      お名前: order.name,
      注文金額: order.total,
      Square照合: matches.length === 0 ? '対応する注文が見つからない(期間外の可能性)'
                : matches.length > 1 ? '同姓同名が複数件あり要目視確認'
                : paid ? '支払い完了' : '未払い(決済リンク未使用の可能性)',
      Square状態: match ? match.state : null,
      Square金額: match && match.total_money ? match.total_money.amount : null
    };
  });
  return {
    対象期間: days + '日間', 件数: results.length, 結果: results,
    診断_シート物理行数: rows.length, 診断_ヘッダー: header, 診断_SS_URL: SS_URL
  };
}

// お名前が空欄の行を削除する(実際のお客様はフォームの必須入力チェックを通るため、
// お名前が空になるのは動作確認用の直接APIアクセスなど、注文フォーム経由ではない場合に限られる)。
function cleanupBlankNameRows_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = getOrCreateOrderSheet_(ss);
  var rows = sheet.getDataRange().getValues();
  var idxName = rows[0].indexOf('お名前');
  var deleted = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    if (!rows[i][idxName]) {
      deleted.push(i + 1);
      sheet.deleteRow(i + 1);
    }
  }
  return { 削除した行: deleted, 残り行数: sheet.getLastRow() - 1 };
}

// お名前が完全一致する行を削除する(テスト注文の後片付け用)。
function deleteRowsByName_(name) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = getOrCreateOrderSheet_(ss);
  var rows = sheet.getDataRange().getValues();
  var idxName = rows[0].indexOf('お名前');
  var deleted = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    if (rows[i][idxName] === name) {
      deleted.push(i + 1);
      sheet.deleteRow(i + 1);
    }
  }
  return { 削除した行: deleted, 残り行数: sheet.getLastRow() - 1 };
}
