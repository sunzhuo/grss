function doGet() {
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();
  var rssItems = [];

  try {
    // ==========================================
    // --- 步骤 1: 智能获取/更新频道列表 (进阶版) ---
    // ==========================================
    var cachedChannelsRaw = props.getProperty('cached_channels');
    var lastSyncList = parseInt(props.getProperty('last_sync_list') || 0);
    // 初始化为 -1 是为了防止第一次运行时 currentSubCount 为 0 导致误判为未更改
    var lastSubCount = parseInt(props.getProperty('last_sub_count') || -1); 
    var lastFirstChannelId = props.getProperty('last_first_channel_id') || "";

    var channels = [];

    // 1. 极速探测：只拉取 1 条数据，获取“订阅总数”和“列表第一个(最新)频道ID”
    var quickCheck = YouTube.Subscriptions.list('snippet', { mine: true, maxResults: 1 });
    var currentSubCount = quickCheck.pageInfo ? quickCheck.pageInfo.totalResults : 0;
    var currentFirstChannelId = (quickCheck.items && quickCheck.items.length > 0) 
                                ? quickCheck.items[0].snippet.resourceId.channelId 
                                : "";

    // 2. 核心逻辑：判断是否需要触发全量更新
    var needsUpdate = !cachedChannelsRaw ||                                 // 情况1：完全没有缓存（第一次运行）
                      currentSubCount !== lastSubCount ||                   // 情况2：订阅总数量发生了变化
                      currentFirstChannelId !== lastFirstChannelId ||       // 情况3：数量没变，但最新订阅的频道换了 (一增一减)
                      (now - lastSyncList > 2592000000);                    // 情况4：超过30天，强制全量同步一次作为兜底

    if (needsUpdate) {
      console.log("检测到订阅列表变化或缓存过期，开始全量同步...");
      var nextPageToken = '';
      do {
        var subResponse = YouTube.Subscriptions.list('snippet', {
          mine: true, maxResults: 50, pageToken: nextPageToken
        });
        if (subResponse.items) {
          subResponse.items.forEach(item => channels.push({
            id: item.snippet.resourceId.channelId, 
            name: item.snippet.title
          }));
        }
        nextPageToken = subResponse.nextPageToken;
      } while (nextPageToken);

      // 更新所有缓存状态
      props.setProperty('cached_channels', JSON.stringify(channels));
      props.setProperty('last_sync_list', now.toString());
      props.setProperty('last_sub_count', currentSubCount.toString());
      props.setProperty('last_first_channel_id', currentFirstChannelId);
    } else {
      // 如果没有任何变化，直接从缓存瞬间读取
      channels = JSON.parse(cachedChannelsRaw);
    }

    // ==========================================
    // --- 步骤 2: 遍历频道并执行自适应检查 ---
    // ==========================================
    channels.forEach(function(channel) {
      var propKey = "state_" + channel.id;
      var stateRaw = props.getProperty(propKey);
      var state = stateRaw ? JSON.parse(stateRaw) : { interval: 4, nextCheck: 0, lastVideoId: "", lastPublishedAt: 0, avgUploadGapDays: 30, inactiveScore: 0, status: "new", cachedVideos: [] };

      // 兼容历史缓存：老状态可能没有 status，且 interval 可能已经被放大到 >24h
      if (!state.status) {
        state.status = "legacy_unclassified";
      }
      if (state.status !== "inactive_suspected" && state.interval > 24) {
        state.interval = 24;
        if (state.nextCheck > now + 24 * 3600000) {
          state.nextCheck = now + 24 * 3600000;
        }
        props.setProperty(propKey, JSON.stringify(state));
      }

      // 兼容历史缓存：老状态可能没有 status，且 interval 可能已经被放大到 >24h
      if (!state.status) {
        state.status = "legacy_unclassified";
      }
      if (state.status !== "inactive_suspected" && state.interval > 24) {
        state.interval = 24;
        if (state.nextCheck > now + 24 * 3600000) {
          state.nextCheck = now + 24 * 3600000;
        }
        props.setProperty(propKey, JSON.stringify(state));
      }

      // 情况 A: 每次调用都抓取该频道最新视频（不再按时间间隔跳过）
      try {
          var uploadsPlaylistId = "UU" + channel.id.substring(2);
          var playlistResponse = YouTube.PlaylistItems.list('snippet', {
            playlistId: uploadsPlaylistId, maxResults: 3
          });

          if (playlistResponse.items && playlistResponse.items.length > 0) {
            var latestVideoId = playlistResponse.items[0].snippet.resourceId.videoId;

            // 频率调整逻辑
            var latestPublishedAt = new Date(playlistResponse.items[0].snippet.publishedAt).getTime();

            if (latestVideoId !== state.lastVideoId) {
              // 有新视频：更新频道活跃信息，并收缩检查间隔
              if (state.lastPublishedAt && latestPublishedAt < state.lastPublishedAt) {
                var gapDays = Math.max(1, (state.lastPublishedAt - latestPublishedAt) / 86400000);
                state.avgUploadGapDays = (state.avgUploadGapDays * 0.7) + (gapDays * 0.3);
              }
              state.lastVideoId = latestVideoId;
              state.lastPublishedAt = latestPublishedAt;
              state.inactiveScore = 0;
              state.status = "active";
              state.interval = 2;
            } else {
              // 无新视频：根据最近发布时间与历史更新节奏，区分“长周期活跃”与“疑似停更”
              var ageDays = Math.max(0, (now - latestPublishedAt) / 86400000);
              var expectedGap = Math.max(7, state.avgUploadGapDays || 30);
              var inactiveThreshold = Math.max(180, expectedGap * 3); // 至少 180 天再判疑似停更

              if (ageDays >= inactiveThreshold) {
                state.status = "inactive_suspected";
                state.inactiveScore = (state.inactiveScore || 0) + 1;
                state.interval = Math.min(state.interval * 1.8, 24 * 7); // 疑似停更：最多每 7 天查一次
              } else {
                state.status = "long_cycle_active";
                state.inactiveScore = 0;
                state.interval = Math.min(state.interval * 1.3, 24); // 长周期但活跃：查询最长间隔 1 天
              }
            }

            // 获取视频时长，过滤掉3分钟(180秒)以内的短视频
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
      } catch (e) { 
          // 频道可能被封禁或删除，静默跳过
          console.log("跳过失效频道: " + channel.name); 
      }

      // 情况 B: 无论是否到期，都把该频道缓存中的视频加入 RSS 列表
      if (state.cachedVideos && state.cachedVideos.length > 0) {
        rssItems = rssItems.concat(state.cachedVideos);
      }
    });

  } catch (e) {
    return ContentService.createTextOutput("脚本错误: " + e.message);
  }

  // ==========================================
  // --- 步骤 3: 排序并输出 RSS (限制总数，防止 XML 过大) ---
  // ==========================================
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

// ==========================================
// --- 辅助函数 ---
// ==========================================

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
 * 在 GAS 编辑器中选择此函数并点击"运行"即可
 */
function emergencyReset() {
  var props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  console.log("所有缓存已清空！请现在重新访问 Web 应用或运行 doGet。");
}

/**
 * 辅助函数：在控制台打印所有频道的当前更新频率和下次检查时间
 * 在 GAS 编辑器中选择此函数并点击"运行"即可查看日志
 */
function checkChannelStats() {
  var props = PropertiesService.getScriptProperties();
  var cachedChannelsRaw = props.getProperty('cached_channels');
  
  if (!cachedChannelsRaw) {
    console.log("❌ 尚未生成频道缓存，请先运行一次 doGet() 或等待触发器执行。");
    return;
  }
  
  var channels = JSON.parse(cachedChannelsRaw);
  var now = new Date().getTime();
  var stats = [];
  
  console.log("📊 === 频道更新频率及状态报告 ===");
  console.log("总计订阅频道数: " + channels.length);
  console.log("--------------------------------------------------");
  
  // 遍历所有频道，收集它们的状态信息
  channels.forEach(function(channel) {
    var stateRaw = props.getProperty("state_" + channel.id);
    
    if (stateRaw) {
      var state = JSON.parse(stateRaw);
      var intervalHours = state.interval.toFixed(2); // 保留两位小数
      // 格式化下次检查时间
      var nextCheckDate = state.nextCheck > 0 ? new Date(state.nextCheck).toLocaleString() : "立刻";
      // 判断当前状态
      var status = (now >= state.nextCheck) ? "🟢 等待抓取" : "⏳ 冷却中";
      
      stats.push({
        name: channel.name,
        intervalNum: state.interval,
        intervalText: intervalHours + " 小时",
        nextCheck: nextCheckDate,
        status: status + (state.status ? " / " + state.status : ""),
        cachedCount: state.cachedVideos ? state.cachedVideos.length : 0
      });
    } else {
      stats.push({
        name: channel.name,
        intervalNum: 9999, // 设为极大值，排在最后
        intervalText: "尚未初始化",
        nextCheck: "-",
        status: "⚪ 未处理",
        cachedCount: 0
      });
    }
  });
  
  // 为了方便查看，按照检查频率（间隔时间）从短到长进行排序
  // 更新最频繁（最活跃）的频道会排在最上面
  stats.sort((a, b) => a.intervalNum - b.intervalNum);
  
  // 输出到日志
  stats.forEach(function(s, index) {
    var logStr = Utilities.formatString(
      "%03d. [%s] \n    ⏱ 检查间隔: %-8s | 📦 缓存视频: %-2d | 状态: %s | 下次检查: %s",
      index + 1, 
      s.name, 
      s.intervalText, 
      s.cachedCount, 
      s.status, 
      s.nextCheck
    );
    console.log(logStr);
  });
  
  console.log("==================================================");
}
