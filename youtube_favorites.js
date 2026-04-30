function doGet() {
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();
  var rssItems = [];

  // 时间常量定义
  var ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000; // 365天
  var ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000; // 30天

  try {
    // ==========================================
    // --- 步骤 1: 智能获取/更新频道列表 ---
    // ==========================================
    var cachedChannelsRaw = props.getProperty('cached_channels');
    var lastSyncList = parseInt(props.getProperty('last_sync_list') || 0);
    var lastSubCount = parseInt(props.getProperty('last_sub_count') || -1); 
    var lastFirstChannelId = props.getProperty('last_first_channel_id') || "";

    var channels = [];

    // 1. 极速探测
    var quickCheck = YouTube.Subscriptions.list('snippet', { mine: true, maxResults: 1 });
    var currentSubCount = quickCheck.pageInfo ? quickCheck.pageInfo.totalResults : 0;
    var currentFirstChannelId = (quickCheck.items && quickCheck.items.length > 0) 
                                ? quickCheck.items[0].snippet.resourceId.channelId 
                                : "";

    // 2. 核心逻辑：判断是否需要触发全量更新
    var needsUpdate = !cachedChannelsRaw ||                                 
                      currentSubCount !== lastSubCount ||                   
                      currentFirstChannelId !== lastFirstChannelId ||       
                      (now - lastSyncList > 2592000000);                    

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
      channels = JSON.parse(cachedChannelsRaw);
    }

    // ==========================================
    // --- 步骤 2: 遍历频道并应用“僵尸频道”过滤策略 ---
    // ==========================================
    channels.forEach(function(channel) {
      var stateKey = "state_" + channel.id;
      var stateRaw = props.getProperty(stateKey);
      var state = stateRaw ? JSON.parse(stateRaw) : { status: "active", lastCheckTime: 0 };

      // 【核心过滤】如果是僵尸频道，且距离上次检查不到一个月，直接跳过 API 请求
      if (state.status === "zombie" && (now - state.lastCheckTime < ONE_MONTH_MS)) {
        return; 
      }

      try {
        var uploadsPlaylistId = "UU" + channel.id.substring(2);
        var playlistResponse = YouTube.PlaylistItems.list('snippet', {
          playlistId: uploadsPlaylistId, maxResults: 3
        });

        // 只要请求了 API，就更新检查时间
        state.lastCheckTime = now; 

        if (playlistResponse.items && playlistResponse.items.length > 0) {
          var latestPublishedAt = new Date(playlistResponse.items[0].snippet.publishedAt).getTime();
          
          // 【状态判定】判断最新视频是否是一年前发布的
          if (now - latestPublishedAt > ONE_YEAR_MS) {
            state.status = "zombie";
          } else {
            state.status = "active";
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

          // 如果频道有视频（不管是不是僵尸，都推入池子参与按时间排序）
          playlistResponse.items.forEach(function(item) {
            var vid = item.snippet.resourceId.videoId;
            if ((durationMap[vid] || 0) >= 180) {
              rssItems.push({
                title: channel.name + "：" + item.snippet.title,
                link: "https://www.youtube.com/watch?v=" + vid,
                pubDate: new Date(item.snippet.publishedAt).toUTCString()
              });
            }
          });
        } else {
          // 如果频道完全没有任何视频，也归类为僵尸频道
          state.status = "zombie";
        }
        
        // 将频道最新状态写回缓存
        props.setProperty(stateKey, JSON.stringify(state));

      } catch (e) { 
        console.log("跳过失效频道: " + channel.name); 
      }
    });

  } catch (e) {
    return ContentService.createTextOutput("脚本错误: " + e.message);
  }

  // ==========================================
  // --- 步骤 3: 排序并输出 RSS ---
  // ==========================================
  rssItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  var finalItems = rssItems.slice(0, 50);

  var rssXml = '<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0"><channel>';
  rssXml += '<title>YouTube 订阅 (带僵尸频道休眠优化)</title><link>https://www.youtube.com</link>';
  
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
 * 运行此函数来清空频道列表缓存
 */
function emergencyReset() {
  var props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  console.log("所有缓存已清空！请现在重新访问 Web 应用或运行 doGet。");
}

/**
 * 查询所有频道状态（僵尸/活跃）的统计报告
 * 在 GAS 编辑器中选择此函数并点击"运行"即可查看日志
 */
function printChannelStatus() {
  var props = PropertiesService.getScriptProperties();
  var cachedChannelsRaw = props.getProperty('cached_channels');
  
  if (!cachedChannelsRaw) {
    console.log("❌ 尚未生成频道列表缓存。请先访问一次你的 Web 应用链接触发抓取。");
    return;
  }
  
  var channels = JSON.parse(cachedChannelsRaw);
  var now = new Date().getTime();
  var activeCount = 0;
  var zombieCount = 0;
  
  console.log("📊 === 频道更新状态报告 ===");
  
  channels.forEach(function(channel) {
    var stateRaw = props.getProperty("state_" + channel.id);
    var status = "active"; // 默认新建频道当作活跃处理
    var nextCheckText = "每次运行均检查";
    
    if (stateRaw) {
      var state = JSON.parse(stateRaw);
      status = state.status || "active";
      
      if (status === "zombie") {
        var nextCheckTime = state.lastCheckTime + (30 * 24 * 60 * 60 * 1000);
        if (nextCheckTime > now) {
          var daysLeft = ((nextCheckTime - now) / (1000 * 60 * 60 * 24)).toFixed(1);
          nextCheckText = "休眠中，" + daysLeft + " 天后复查";
        } else {
          nextCheckText = "立刻检查 (休眠期已满)";
        }
      }
    }
    
    if (status === "zombie") {
      zombieCount++;
      console.log("🧟 [僵尸频道] " + channel.name + " | 状态: " + nextCheckText);
    } else {
      activeCount++;
      console.log("🟢 [活跃频道] " + channel.name + " | 状态: " + nextCheckText);
    }
  });
  
  console.log("--------------------------------------------------");
  console.log("总计订阅数: " + channels.length);
  console.log("🟢 活跃频道: " + activeCount + " 个 (每次获取耗费 2 点配额)");
  console.log("🧟 僵尸频道: " + zombieCount + " 个 (仅每月获取时耗费配额)");
  
  // 帮你预估当前的单次配额消耗
  var currentCost = 1 + (activeCount * 2);
  console.log("💡 预估当前每次触发脚本消耗配额: " + currentCost + " 点 / 10000 点");
  console.log("==================================================");
}
