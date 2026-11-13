'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var childProcess = require('child_process');

// ---------------------------------------------------------------- 常量与默认值

var PLUGIN_NAME = 'hexo-google-adsense';
var DEFAULT_TAG_NAME = 'GoogleAdsense';
var DEFAULT_FILE_PATH = 'source/ads/google/article_ads.html';
var DEFAULT_TIMEOUT = 15 * 1000;
var DEFAULT_CACHE_TTL = 60 * 60 * 1000;

// 远程文件大小上限，避免误配大文件把内存吃满
var MAX_REMOTE_BYTES = 1024 * 1024;
// 最多跟随的重定向次数，防止重定向死循环
var MAX_REDIRECTS = 5;
// 同一条错误在冷却时间内只记录一次，避免每篇文章/每次渲染都刷日志
var ERROR_COOLDOWN = 60 * 1000;
// 广告代码特征：必须真的带有广告单元属性，避免把普通网页（例如 404 页面）当成广告代码
var AD_MARKER = /data-ad-(?:client|slot)\s*=/i;

// 下载远程广告代码时使用的请求头；不要求压缩，保证拿到纯文本
var REQUEST_HEADERS = {
  'user-agent': PLUGIN_NAME + ' (+https://github.com/rqh656418510/hexo-google-adsense)',
  accept: 'text/html,application/xhtml+xml,text/plain,*/*',
  'accept-encoding': 'identity'
};

// ---------------------------------------------------------------- 通用工具

// 把配置值解析成布尔值，兼容 true/false、'true'/'false'、'yes'/'no'、'on'/'off' 等写法
function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    var text = value.trim().toLowerCase();
    if (text === '') return fallback;
    if (text === 'true' || text === 'yes' || text === 'on') return true;
    if (text === 'false' || text === 'no' || text === 'off') return false;
  }
  return fallback;
}

// 解析正数配置（毫秒等），只接受数字或数字字符串，非法值/非正数时回退默认值
function parsePositiveNumber(value, fallback) {
  if (typeof value === 'number') {
    return isFinite(value) && value > 0 ? value : fallback;
  }
  if (typeof value === 'string') {
    var text = value.trim();
    if (text === '') return fallback;
    var number = Number(text);
    return isFinite(number) && number > 0 ? number : fallback;
  }
  return fallback;
}

// 解析时长配置：0 表示永不过期（仅用于 TTL 类配置）
function parseDuration(value, fallback) {
  if (value === 0 || value === '0') return 0;
  return parsePositiveNumber(value, fallback);
}

// 解析预取模式：wait（预取并等待）、async（预取但不等待）、off（不预取）
function parsePrefetchMode(value, log) {
  if (value === undefined || value === null) return 'wait';
  if (typeof value === 'boolean') return value ? 'wait' : 'off';
  if (typeof value === 'string') {
    var text = value.trim().toLowerCase();
    if (text === '') return 'wait';
    if (text === 'wait' || text === 'true') return 'wait';
    if (text === 'async') return 'async';
    if (text === 'off' || text === 'false' || text === 'none') return 'off';
  }
  log.warn('Invalid prefetch "' + value + '", expected "wait", "async" or "off", fallback to "wait"');
  return 'wait';
}

// 判断是否是 http/https 地址，大小写不敏感，非字符串不会抛错
function isWebUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

// 判断是否是其他协议地址（例如 ftp://），用于给出明确提示而不是当成文件路径
function hasNonHttpProtocol(value) {
  if (typeof value !== 'string') return false;
  var source = value.trim();
  // Windows 盘符路径（如 C:/、D:\）不是协议，交给本地文件解析
  if (/^[a-z]:[\\/]/i.test(source)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

// 去掉 UTF-8 BOM，避免广告代码开头出现不可见字符
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 转义正则元字符，用于把标签名安全地拼进正则
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 根据 URL 协议选择下载模块：HTTP 用 http，HTTPS 用 https，其他协议不支持
function getTransport(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  return null;
}

// 把异常转成可读的日志文案
function describeError(err) {
  if (err && err.code === 'ENOENT') {
    return 'curl is not available, cannot fetch the remote file synchronously';
  }
  if (err && err.message) return err.message;
  return String(err);
}

// hexo.log 一般由 Hexo 实例提供，这里只做兜底
function fallbackLogger() {
  // 生成某个级别的日志函数
  function write(printer) {
    return function() {
      var parts = Array.prototype.map.call(arguments, String);
      printer('[' + PLUGIN_NAME + '] ' + parts.join(' '));
    };
  }
  return {
    error: write(console.error.bind(console)),
    warn: write(console.warn.bind(console)),
    info: write(console.log.bind(console)),
    debug: function() {}
  };
}

// ---------------------------------------------------------------- 插件配置

// 读取并规整 hexo_google_adsense 配置，所有字段都有安全的默认值
function readOptions(instance, log) {
  var section = instance.config ? instance.config.hexo_google_adsense : null;
  var raw = section && typeof section === 'object' ? section : {};

  var tagName = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  if (!tagName) {
    tagName = DEFAULT_TAG_NAME;
  } else if (/\s/.test(tagName)) {
    // 标签名里带空白会让 Hexo 无法解析 {% tag %}，直接回退到默认值
    log.warn('Invalid tag_name "' + raw.tag_name + '": whitespace is not allowed, fallback to "' + DEFAULT_TAG_NAME + '"');
    tagName = DEFAULT_TAG_NAME;
  }

  var filePath = typeof raw.file_path === 'string' ? raw.file_path.trim() : '';
  if (!filePath) filePath = DEFAULT_FILE_PATH;

  return {
    enable: parseBoolean(raw.enable, false),
    logMsg: parseBoolean(raw.log_msg, false),
    tagName: tagName,
    filePath: filePath,
    cache: parseBoolean(raw.cache, true),
    cacheTtl: parseDuration(raw.cache_ttl, DEFAULT_CACHE_TTL),
    timeout: parsePositiveNumber(raw.timeout, DEFAULT_TIMEOUT),
    prefetch: parsePrefetchMode(raw.prefetch, log)
  };
}

// ---------------------------------------------------------------- 广告代码来源

// 创建广告代码读取器：负责本地文件读取、HTTP/HTTPS 下载与缓存
function createAdsProvider(instance, options, log) {
  var baseDir = instance.base_dir || process.cwd();
  var sourceDir = instance.source_dir || baseDir;
  // 本地文件按 mtime 缓存，远程文件按 TTL 缓存
  var fileCache = Object.create(null);
  var urlCache = Object.create(null);
  var lastNotified = Object.create(null);

  // 记录错误日志，同一 key 在冷却时间内只打印一次
  function notifyError(key, message) {
    var now = Date.now();
    if (lastNotified[key] && now - lastNotified[key] < ERROR_COOLDOWN) return;
    lastNotified[key] = now;
    log.error(message);
  }

  // 解析本地文件路径并返回文件信息：相对路径按根目录、source 目录依次尝试
  // 返回 { file, stats }；stats 为 null 表示不可用（不存在或不是文件）
  function resolveLocalFile(filePath) {
    var candidates = path.isAbsolute(filePath)
      ? [filePath]
      : [path.join(baseDir, filePath), path.join(sourceDir, filePath)];
    var error = null;

    for (var i = 0; i < candidates.length; i++) {
      var file = candidates[i];
      try {
        var stats = fs.statSync(file);
        if (stats.isFile()) return { file: file, stats: stats };
        if (!error) error = 'Google adsense path is not a file: ' + file;
      } catch (err) {
        if (!error) {
          error = 'Google adsense file not found: ' + file + ' (' + (err.code || err.message) + ')';
        }
      }
    }

    return { file: candidates[0], stats: null, error: error };
  }

  // 读取本地广告文件：命中 mtime 缓存时直接返回，文件缺失/不是文件时记录错误
  function getLocalCode(filePath) {
    var resolved = resolveLocalFile(filePath);
    var file = resolved.file;
    var stats = resolved.stats;

    if (!stats) {
      notifyError('file:' + file, resolved.error);
      return '';
    }

    // 文件没变（mtime 相同）就直接用缓存，避免每篇文章都读一次磁盘
    var cached = fileCache[file];
    if (options.cache && cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.content;
    }

    var content;
    try {
      content = stripBom(fs.readFileSync(file, 'utf8')).trim();
    } catch (err) {
      notifyError('file-read:' + file,
        'Read google adsense file failed: ' + file + ' (' + (err.code || err.message) + ')');
      return '';
    }

    fileCache[file] = { mtimeMs: stats.mtimeMs, content: content };
    return content;
  }

  // 取出（必要时创建）某个远程地址的缓存状态
  function getUrlState(url) {
    if (!urlCache[url]) {
      urlCache[url] = { content: '', fetchedAt: 0, failedAt: 0, pending: null };
    }
    return urlCache[url];
  }

  // 判断远程缓存是否需要重新下载（无内容、关闭缓存或超过 TTL）
  function isStale(state) {
    if (!state.content) return true;
    if (!options.cache) return true;
    if (options.cacheTtl <= 0) return false;
    return Date.now() - state.fetchedAt >= options.cacheTtl;
  }

  // 校验远程内容：必须是包含广告单元属性的代码，否则视为异常内容
  function validateRemote(raw, url) {
    var content = stripBom(String(raw)).trim();
    if (!content) {
      notifyError('remote-empty:' + url, 'Google adsense file is empty: ' + url);
      return '';
    }
    if (!AD_MARKER.test(content)) {
      notifyError('remote-invalid:' + url,
        'Google adsense file content abnormal: ' + url + ' (missing data-ad-client / data-ad-slot)');
      return '';
    }
    return content;
  }

  // 同步兜底下载：预取未命中或 prefetch 为 off 时使用，依赖系统 curl（HTTP/HTTPS 都支持）
  function fetchRemoteSync(url) {
    var seconds = Math.max(1, Math.ceil(options.timeout / 1000));
    var args = [
      '--silent', '--show-error', '--location', '--fail', '--compressed',
      '--max-time', String(seconds), '--url', url
    ];
    return childProcess.execFileSync('curl', args, {
      encoding: 'utf8',
      timeout: options.timeout + 1000,
      maxBuffer: MAX_REMOTE_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  // 同步读取远程广告代码：优先用缓存，缓存为空时用 curl 兜底
  function getRemoteCode(url) {
    var state = getUrlState(url);
    if (state.content) return state.content;
    // async 模式要求渲染阶段绝不阻塞：没命中缓存就留空，等后台预取补上
    if (options.prefetch === 'async') return '';
    // 预取还在进行中或刚刚失败过，本次先留空，等下一次渲染命中缓存
    if (state.pending) return '';
    if (state.failedAt && Date.now() - state.failedAt < ERROR_COOLDOWN) return '';

    var raw;
    try {
      raw = fetchRemoteSync(url);
    } catch (err) {
      state.failedAt = Date.now();
      notifyError('remote-sync:' + url,
        'Read google adsense file failed: ' + url + ' (' + describeError(err) + ')');
      return '';
    }

    var content = validateRemote(raw, url);
    if (content) {
      state.content = content;
      state.fetchedAt = Date.now();
      state.failedAt = 0;
    } else {
      state.failedAt = Date.now();
    }
    return content;
  }

  // 异步下载远程广告代码：支持 HTTP 和 HTTPS，带超时、重定向上限与大小上限
  function requestRemote(url, timeout, redirectsLeft) {
    return new Promise(function(resolve, reject) {
      var parsed;
      try {
        parsed = new URL(url);
      } catch (err) {
        reject(new Error('Invalid URL "' + url + '"'));
        return;
      }

      // 按协议选择 http / https 模块，非 http(s) 协议直接失败
      var transport = getTransport(parsed);
      if (!transport) {
        reject(new Error('Unsupported protocol in "' + url + '"'));
        return;
      }

      var settled = false;
      var timer = null;

      // 收尾函数：保证 Promise 只结算一次，并清理超时计时器
      function finish(err, content) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(content);
      }

      // agent: false 避免 keep-alive 连接拖慢 hexo 命令退出
      var req = transport.get(parsed, { headers: REQUEST_HEADERS, agent: false }, function(res) {
        var status = res.statusCode || 0;

        // 3xx 且有 Location：跟随重定向，HTTP 与 HTTPS 之间跳转也支持
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            finish(new Error('Too many redirects: ' + url));
            return;
          }
          var next;
          try {
            next = new URL(res.headers.location, parsed).toString();
          } catch (err) {
            finish(new Error('Invalid redirect target from "' + url + '": ' + res.headers.location));
            return;
          }
          // 交给下一跳请求自己的超时计时器
          if (timer) clearTimeout(timer);
          timer = null;
          requestRemote(next, timeout, redirectsLeft - 1).then(function(content) {
            finish(null, content);
          }, finish);
          return;
        }

        // 非 200 一律视为失败（404 页面不能被当成广告代码）
        if (status !== 200) {
          res.resume();
          finish(new Error('Unexpected HTTP status ' + status + ' for ' + url));
          return;
        }

        // 边下载边统计大小，超过上限立即中断，避免异常配置拖垮内存
        var chunks = [];
        var size = 0;
        res.on('data', function(chunk) {
          size += chunk.length;
          if (size > MAX_REMOTE_BYTES) {
            req.destroy(new Error('Response exceeds ' + MAX_REMOTE_BYTES + ' bytes: ' + url));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', function() {
          finish(null, Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', finish);
      });

      req.on('error', finish);
      // 总超时：从发起请求到收到完整响应，超时后销毁请求并报错
      timer = setTimeout(function() {
        req.destroy(new Error('Request timed out after ' + timeout + 'ms: ' + url));
      }, timeout);
      // 极少数情况下响应可能在计时器赋值前就已结束，避免遗留一个空转的计时器
      if (settled) {
        clearTimeout(timer);
        timer = null;
      }
    });
  }

  // 并行预取一批远程地址（供 before_generate / before_post_render 调用），失败只记录不抛错
  function prefetch(urls) {
    var tasks = [];

    urls.forEach(function(url) {
      if (!isWebUrl(url)) return;

      var state = getUrlState(url);
      // 已有请求在途时复用同一个 Promise，避免重复下载
      if (state.pending) {
        tasks.push(state.pending);
        return;
      }
      if (!isStale(state)) return;
      // 刚失败过的地址在冷却时间内不再重试，避免每篇文章都等一次超时
      if (state.failedAt && Date.now() - state.failedAt < ERROR_COOLDOWN) return;

      state.pending = requestRemote(url, options.timeout, MAX_REDIRECTS).then(function(raw) {
        try {
          var content = validateRemote(raw, url);
          if (content) {
            state.content = content;
            state.fetchedAt = Date.now();
            state.failedAt = 0;
          } else {
            state.failedAt = Date.now();
          }
        } finally {
          // 无论成功与否都清掉 pending，避免异常把状态卡住
          state.pending = null;
        }
      }, function(err) {
        state.failedAt = Date.now();
        state.pending = null;
        notifyError('remote-async:' + url,
          'Read google adsense file failed: ' + url + ' (' + describeError(err) + ')');
      });

      tasks.push(state.pending);
    });

    return Promise.all(tasks);
  }

  // 统一的取码入口：URL 走远程（HTTP/HTTPS），否则按本地文件读取
  function getCode(target) {
    var source = typeof target === 'string' ? target.trim() : '';
    if (!source) source = options.filePath;

    if (isWebUrl(source)) return getRemoteCode(source);
    if (hasNonHttpProtocol(source)) {
      notifyError('protocol:' + source, 'Unsupported protocol, only http/https are supported: ' + source);
      return '';
    }
    return getLocalCode(source);
  }

  return {
    getCode: getCode,
    prefetch: prefetch
  };
}

// ---------------------------------------------------------------- 插件注册

// 防止「全局 hexo 自动注册」与「导出函数被 Hexo 调用」两条路径重复注册
var installed = typeof WeakSet === 'function' ? new WeakSet() : null;

// 插件的初始化入口：读取配置、创建读取器并注册标签与过滤器
function setup(instance) {
  if (!instance || typeof instance !== 'object') return instance;
  if (!instance.extend || !instance.extend.tag) return instance;
  if (installed) {
    if (installed.has(instance)) return instance;
    installed.add(instance);
  }

  var log = instance.log && typeof instance.log.error === 'function' ? instance.log : fallbackLogger();
  var options = readOptions(instance, log);
  var provider = createAdsProvider(instance, options, log);

  // 判断文章里是否出现了本插件的标签：兼容 {% X %}、{%X%}、{% X%}
  var tagOpeningPattern = new RegExp('\\{%\\s*' + escapeRegExp(options.tagName) + '(?=\\s|%|\\})');
  // 提取 {% X 'https://...' %} 形式的远程地址，用于渲染前预取（仅匹配受支持的写法）
  var tagUrlPattern = new RegExp(
    '\\{%\\s*' + escapeRegExp(options.tagName) + '\\s+["\']?(https?:\\/\\/[^"\'\\s}]+)',
    'gi'
  );

  // 从文章内容里提取所有远程广告地址
  function extractRemoteSources(content) {
    var urls = [];
    var match;
    tagUrlPattern.lastIndex = 0;
    while ((match = tagUrlPattern.exec(content)) !== null) {
      urls.push(match[1]);
    }
    return urls;
  }

  // 标签渲染函数：读取广告代码并原样输出到文章中
  function insertAds(args, content) {
    var fallback = typeof content === 'string' ? content : '';
    if (!options.enable) return fallback;

    // 支持 {% GoogleAdsense 'ads/other.html' %} 为单篇文章指定其它广告文件
    var target = options.filePath;
    var arg = args && args.length > 0 ? args[0] : undefined;
    if (typeof arg === 'string') {
      if (arg.trim()) target = arg.trim();
    } else if (typeof arg === 'number' || typeof arg === 'boolean') {
      // 防御性处理：正常写法下 Hexo 传入的都是字符串，这里只兜住异常参数
      log.warn('Ignored invalid ' + options.tagName + ' argument: ' + String(arg) + ' (quote the path or URL)');
    } else if (arg && typeof arg === 'object' && Object.keys(arg).length > 0) {
      log.warn('Ignored invalid ' + options.tagName + ' argument: ' + String(arg) + ' (quote the path or URL)');
    }

    return provider.getCode(target) || fallback;
  }

  // 注册 Hexo 自定义标签（即使 enable 为 false 也注册，避免文章里的标签变成未知标签）
  instance.extend.tag.register(options.tagName, insertAds);

  if (instance.extend.filter && typeof instance.extend.filter.register === 'function') {
    // 文章渲染前：按需打印日志，并按 prefetch 模式预取本文用到的远程广告代码
    instance.extend.filter.register('before_post_render', function(data) {
      if (!options.enable || !data) return data;

      var content = typeof data.content === 'string' ? data.content : '';

      if (options.logMsg && tagOpeningPattern.test(content)) {
        log.info('Insert google adsense code for blog: ' + (data.title || data.source || '(untitled)'));
      }

      // off 模式不做任何预取，交给渲染时的同步读取
      if (options.prefetch === 'off') return data;

      var remoteUrls = extractRemoteSources(content);
      if (remoteUrls.length === 0) return data;

      var pending = provider.prefetch(remoteUrls);
      // async 模式只发起后台预取，不等下载完成
      if (options.prefetch === 'async') {
        pending.catch(function() {});
        return data;
      }
      // wait 模式（默认）等下载完成再渲染，保证产物里的广告不缺失；失败也不中断构建
      return pending.then(function() {
        return data;
      }, function() {
        return data;
      });
    });

    // 生成前：按 prefetch 模式预取配置里的远程广告代码（失败不影响构建）
    instance.extend.filter.register('before_generate', function() {
      if (!options.enable || options.prefetch === 'off' || !isWebUrl(options.filePath)) return;

      var pending = provider.prefetch([options.filePath]);
      // async 模式只发起后台预取，不等下载完成
      if (options.prefetch === 'async') {
        pending.catch(function() {});
        return;
      }
      // 预取失败只记录不抛错；再兜一层，保证构建绝不因广告失败而中断
      return pending.catch(function() {});
    });
  }

  return instance;
}

module.exports = setup;
module.exports.setup = setup;

// 兼容 Hexo 的全局变量加载方式（插件在 Hexo 中被 require 时存在全局 hexo）
if (typeof hexo !== 'undefined' && hexo) {
  setup(hexo);
}
