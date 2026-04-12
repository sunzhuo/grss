// ================= 配置区域 =================
// 请修改下面的密钥，就像设置密码一样 (用于保护你的 Feed)
var SECRET_KEY = "your_secret_key"; 

// 邮件搜索查询 (默认: 收件箱中的前 20 封邮件)
// 你可以改为 "is:unread" (仅未读) 或 "label:work" (特定标签)
var SEARCH_QUERY = "label:inbox category:primary";
var MAX_EMAILS = 20; 
// ===========================================

function doGet(e) {
  // 1. 安全检查：验证 URL 中的 key 参数
  if (!e.parameter.key || e.parameter.key !== SECRET_KEY) {
    return ContentService.createTextOutput("Error: Invalid or missing Access Key.")
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // 2. 初始化 RSS XML 结构
  var rss = '<?xml version="1.0" encoding="UTF-8"?>';
  rss += '<rss version="2.0">';
  rss += '<channel>';
  rss += '<title>My Gmail Inbox</title>';
  rss += '<link>https://mail.google.com</link>';
  rss += '<description>Personal Gmail RSS Feed via Apps Script</description>';

  try {
    // 3. 获取邮件线程
    var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_EMAILS);
    
    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      // 获取该线程中最新的一封邮件
      var msg = messages[messages.length - 1]; 
      
      var subject = msg.getSubject() || "(No Subject)";
      var from = msg.getFrom();
      var date = msg.getDate().toUTCString(); // RSS 需要 RFC 822 格式时间
      var body = msg.getPlainBody(); // 为了由于 RSS 阅读器兼容性，建议使用纯文本
      // 如果非常需要 HTML，可以使用 msg.getBody()，但需要放入 CDATA
      
      // 生成单条 RSS Item
      rss += '<item>';
      rss += '<title><![CDATA[' + subject + ']]></title>';
      rss += '<author><![CDATA[' + from + ']]></author>';
      rss += '<pubDate>' + date + '</pubDate>';
      rss += '<link>https://mail.google.com/mail/u/0/#inbox/' + threads[i].getId() + '</link>';
      rss += '<guid isPermaLink="false">' + msg.getId() + '</guid>';
      rss += '<description><![CDATA[' + body.substring(0, 500) + '...]]></description>'; // 截取前500字预览
      rss += '</item>';
    }
  } catch (error) {
    rss += '<item><title>Error fetching emails</title><description>' + error.toString() + '</description></item>';
  }

  rss += '</channel>';
  rss += '</rss>';

  // 4. 返回 XML 内容
  return ContentService.createTextOutput(rss)
    .setMimeType(ContentService.MimeType.XML);
}
