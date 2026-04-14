function doGet() {
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();
  var rssItems = [];

  try {
    // --- 步骤 1: 获取/更新频道列表 (逻辑不变) ---
    var cachedChannelsRaw = props.getProperty('cached_channels');
    var lastSyncList = parseInt(props.getProperty('last_sync_list') || 0);
    var channels = [];

    if (!cachedChannelsRaw || (now - lastSyncList > 2592000000)) {
      var nextPageToken = '';
      do {
        var subResponse = YouTube.Subscriptions.list('snippet', {
          mine: true, maxResults: 50, pageToken: nextPageToken
        });
        subResponse.items.forEach(item => channels.push({id: item.snippet.resourceId.channelId, name: item.snippet.title}));
        nextPageToken = subResponse.nextPageToken;
      } while (nextPageToken);
      props.setProperty('cached_channels', JSON.stringify(channels));
      props.setProperty('last_sync_list', now.toString());
    } else {
      channels = JSON.parse(cachedChannelsRaw);
    }

    // --- 步骤 2: 遍历频道并执行自适应检查 ---
    channels.forEach(function(channel) {
      var propKey = "state_" + channel.id;
      var stateRaw = props.getProperty(propKey);
      var state = stateRaw ? JSON.parse(stateRaw) : { interval: 4, nextCheck: 0, lastVideoId: "", cachedVideos: [] };

      // 情况 A: 到期了，去 YouTube 抓取
      if (now >= state.nextCheck) {
        try {
          var uploadsPlaylistId = "UU" + channel.id.substring(2);
          var playlistResponse = YouTube.PlaylistItems.list('snippet', {
            playlistId: uploadsPlaylistId, maxResults: 3
          });

          if (playlistResponse.items && playlistResponse.items.length > 0) {
            var latestVideoId = playlistResponse.items[0].snippet.resourceId.videoId;

            // 频率调整逻辑
            if (latestVideoId !== state.lastVideoId) {
              state.lastVideoId = latestVideoId;
              state.interval = 2; 
            } else {
              state.interval = state.interval * 1.5;
            }

            // 获取视频时长，过滤掉3分钟以内的短视频
            var videoIds = playlistResponse.items.map(item => item.snippet.resourceId.videoId).join(',');
            var detailsResponse = YouTube.Videos.list('contentDetails', { id: videoIds });
            var durationMap = {};
            if (detailsResponse.items) {
              detailsResponse.items.forEach(function(v) {
                durationMap[v.id] = parseDuration(v.contentDetails.duration);
              });
            }

            // 更新缓存的视频内容 (只存必要的字段以节省空间)
            state.cachedVideos = playlistResponse.items
              .filter(item => (durationMap[item.snippet.resourceId.videoId] || 0) >= 180)
              .map(item => ({
              title: channel.name + "：" + item.snippet.title,
              link: "https://www.youtube.com/watch?v=" + item.snippet.resourceId.videoId,
              pubDate: new Date(item.snippet.publishedAt).toUTCString()
            }));

            state.nextCheck = now + (state.interval * 3600000);
            props.setProperty(propKey, JSON.stringify(state));
          }
        } catch (e) { console.log("跳过失效频道: " + channel.name); }
      }

      // 情况 B: 无论是否到期，都把该频道缓存中的视频加入 RSS 列表
      if (state.cachedVideos && state.cachedVideos.length > 0) {
        rssItems = rssItems.concat(state.cachedVideos);
      }
    });

  } catch (e) {
    return ContentService.createTextOutput("脚本错误: " + e.message);
  }

  // --- 步骤 3: 排序并输出 RSS (限制总数，防止 XML 过大) ---
  rssItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  // 只取最新的 50 条视频显示在 RSS 中
  var finalItems = rssItems.slice(0, 50);

  var rssXml = '<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0"><channel>';
  rssXml += '<title>YouTube 极致自适应聚合</title><link>https://www.youtube.com</link>';
  
  finalItems.forEach(function(item) {
    rssXml += '<item><title>' + escapeXml(item.title) + '</title>';
    rssXml += '<link>' + item.link + '</link>';
    rssXml += '<pubDate>' + item.pubDate + '</pubDate>';
    rssXml += '<guid>' + item.link + '</guid></item>';
  });
  
  rssXml += '</channel></rss>';
  return ContentService.createTextOutput(rssXml).setMimeType(ContentService.MimeType.RSS);
}

function parseDuration(iso8601) {
  var match = iso8601.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  var hours = parseInt(match[1] || 0);
  var minutes = parseInt(match[2] || 0);
  var seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function escapeXml(unsafe) {
  return unsafe ? unsafe.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])) : "";
}
/**
 * 运行此函数来清空所有缓存，强制脚本重新开始
 */
function emergencyReset() {
  var props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  console.log("所有缓存已清空！请现在重新访问 Web 应用或运行 doGet。");
}
