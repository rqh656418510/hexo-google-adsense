'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var https = require('https');
var EventEmitter = require('events');

var setup = require('../index.js');

// 一段真实的广告单元代码，远程/本地用例共用
var AD_CODE = [
  '<ins class="adsbygoogle"',
  '  style="display:block"',
  '  data-ad-client="ca-pub-1234567890123456"',
  '  data-ad-slot="1234567890"></ins>',
  '<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>'
].join('\n');

// 创建过的临时目录和测试用 HTTP 服务，统一在所有用例结束后清理
var workspaces = [];
var servers = [];

// 全局清理：关闭测试服务并删除临时目录
test.after(function() {
  servers.forEach(function(server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  });
  workspaces.forEach(function(root) {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// 创建一个模拟的 Hexo 博客根目录（含 source 子目录）
function createWorkspace() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-google-adsense-'));
  fs.mkdirSync(path.join(root, 'source'), { recursive: true });
  workspaces.push(root);
  return root;
}

// 在临时目录里写入文件，自动创建所需的多级目录
function writeAds(root, relative, content) {
  var file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// 模拟 Hexo 实例，只实现插件用到的 API（tag/filter 注册、日志、目录配置）
function makeInstance(root, pluginConfig) {
  var tags = Object.create(null);
  var filters = Object.create(null);
  var logs = [];
  var counters = { tagRegistrations: 0, filterRegistrations: 0 };

  // 生成某一级别的日志记录函数，用于断言插件输出
  function record(level) {
    return function() {
      logs.push(level + ': ' + Array.prototype.map.call(arguments, String).join(' '));
    };
  }

  var instance = {
    base_dir: root + path.sep,
    source_dir: path.join(root, 'source') + path.sep,
    config: { hexo_google_adsense: pluginConfig },
    log: { error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') },
    extend: {
      tag: {
        register: function(name, fn) {
          counters.tagRegistrations += 1;
          tags[name] = fn;
        }
      },
      filter: {
        register: function(name, fn) {
          counters.filterRegistrations += 1;
          if (!filters[name]) filters[name] = [];
          filters[name].push(fn);
        }
      }
    }
  };

  return {
    hexo: instance,
    tags: tags,
    filters: filters,
    logs: logs,
    counters: counters
  };
}

// 创建模拟实例并完成插件注册
function createHexo(root, pluginConfig) {
  var ctx = makeInstance(root, pluginConfig);
  setup(ctx.hexo);
  return ctx;
}

// 取出某个级别的日志，例如 logsOf(ctx, 'error')
function logsOf(ctx, level) {
  return ctx.logs.filter(function(line) {
    return line.indexOf(level + ':') === 0;
  });
}

// 调用插件的标签渲染函数（args 默认空数组，content 默认空字符串）
function renderTag(ctx, name, args, content) {
  return ctx.tags[name](args || [], content === undefined ? '' : content);
}

// 依次执行某一类过滤器，支持异步过滤器（模拟 Hexo 的 filter.exec）
async function applyFilter(ctx, name, data) {
  var handlers = ctx.filters[name] || [];
  var current = data;
  for (var i = 0; i < handlers.length; i++) {
    current = await handlers[i](current);
  }
  return current;
}

// 启动一个监听随机端口的本地 HTTP 服务，返回 base 地址
function startServer(handler) {
  return new Promise(function(resolve) {
    var server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function() {
      servers.push(server);
      resolve({
        server: server,
        base: 'http://127.0.0.1:' + server.address().port
      });
    });
  });
}

// ---------------------------------------------------------------- 基础行为

test('未配置时仍然注册标签，但不注入任何代码', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, undefined);

  assert.strictEqual(typeof ctx.tags.GoogleAdsense, 'function');
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), '');
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('配置不是对象时不会崩溃', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, true);

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), '');
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('enable 为 false 时原样返回内容', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: false });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), '');
});

test('enable 支持字符串形式 "true"', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: 'true' });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), AD_CODE);
});

test('布尔配置不再接受 1/0 写法', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);

  [1, '1'].forEach(function(value) {
    var ctx = createHexo(root, { enable: value });
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文',
      'enable=' + JSON.stringify(value) + ' 不应被视为开启');
  });

  [0, '0'].forEach(function(value) {
    var ctx = createHexo(root, { enable: value });
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文',
      'enable=' + JSON.stringify(value) + ' 不应被视为开启');
  });

  // 其余布尔写法保持可用
  var yes = createHexo(root, { enable: 'yes' });
  assert.strictEqual(renderTag(yes, 'GoogleAdsense', [], '原文'), AD_CODE);
});

// ---------------------------------------------------------------- 本地文件

test('按 Hexo 根目录解析相对路径并注入代码', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', '\n' + AD_CODE + '\n');
  var ctx = createHexo(root, { enable: true });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('相对路径找不到时回退到 source 目录', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/sidebar.html', AD_CODE);
  var ctx = createHexo(root, { enable: true, file_path: 'ads/sidebar.html' });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
});

test('支持绝对路径与 BOM', function() {
  var root = createWorkspace();
  var file = writeAds(root, 'source/ads/absolute.html', '\ufeff' + AD_CODE);
  var ctx = createHexo(root, { enable: true, file_path: file });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
});

test('文件不存在时返回原内容，且同一错误只记录一次', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, file_path: 'source/missing.html' });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');

  var errors = logsOf(ctx, 'error');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /not found/);
});

test('路径是目录时不会崩溃', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, file_path: 'source' });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
  assert.match(logsOf(ctx, 'error')[0], /not a file/);
});

test('根目录同名目录不挡住 source 目录下的同名文件', function() {
  var root = createWorkspace();
  // 根目录下建同名目录，source 目录下才是真正的广告文件
  fs.mkdirSync(path.join(root, 'ads', 'sidebar.html'), { recursive: true });
  writeAds(root, 'source/ads/sidebar.html', AD_CODE);

  var ctx = createHexo(root, { enable: true, file_path: 'ads/sidebar.html' });
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('Windows 盘符路径不会被误判为协议', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, file_path: 'C:/ads/google/ads.html' });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
  var errors = logsOf(ctx, 'error');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /not found/);
  assert.doesNotMatch(errors[0], /Unsupported protocol/);
});

test('复用缓存，避免每次渲染都读文件', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true });

  var originalReadFileSync = fs.readFileSync;
  var reads = 0;
  fs.readFileSync = function() {
    reads += 1;
    return originalReadFileSync.apply(fs, arguments);
  };

  try {
    renderTag(ctx, 'GoogleAdsense', [], '');
    renderTag(ctx, 'GoogleAdsense', [], '');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.strictEqual(reads, 1);
});

test('本地文件修改后（mtime 变化）重新读取', function() {
  var root = createWorkspace();
  var file = writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);

  var updated = AD_CODE.replace('1234567890', '9999999999');
  fs.writeFileSync(file, updated, 'utf8');
  var future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), updated);
});

test('cache 为 false 时每次都重新读取', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true, cache: false });

  var originalReadFileSync = fs.readFileSync;
  var reads = 0;
  fs.readFileSync = function() {
    reads += 1;
    return originalReadFileSync.apply(fs, arguments);
  };

  try {
    renderTag(ctx, 'GoogleAdsense', [], '');
    renderTag(ctx, 'GoogleAdsense', [], '');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.strictEqual(reads, 2);
});

// ---------------------------------------------------------------- 标签配置

test('支持自定义 tag_name', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true, tag_name: 'MyAds' });

  assert.strictEqual(typeof ctx.tags.MyAds, 'function');
  assert.strictEqual(ctx.tags.GoogleAdsense, undefined);
  assert.strictEqual(renderTag(ctx, 'MyAds', [], ''), AD_CODE);
});

test('tag_name 带空白时回退默认值并告警', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, tag_name: ' My Ads ' });

  assert.strictEqual(typeof ctx.tags.GoogleAdsense, 'function');
  assert.strictEqual(logsOf(ctx, 'warn').length, 1);
});

test('标签参数可以指定其它广告文件', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  writeAds(root, 'source/ads/google/sidebar_ads.html', '<ins data-ad-client="ca-pub-1" data-ad-slot="2"></ins>');
  var ctx = createHexo(root, { enable: true });

  assert.strictEqual(
    renderTag(ctx, 'GoogleAdsense', ['ads/google/sidebar_ads.html'], ''),
    '<ins data-ad-client="ca-pub-1" data-ad-slot="2"></ins>'
  );
});

test('参数不是合法路径时告警并回退默认文件', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [300], ''), AD_CODE);
  assert.strictEqual(logsOf(ctx, 'warn').length, 1);
});

test('无参数标签传入空对象时保持静默', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [{}], ''), AD_CODE);
  assert.deepStrictEqual(logsOf(ctx, 'warn'), []);
});

test('重复 setup 不会重复注册标签与过滤器', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true });
  var before = ctx.counters.tagRegistrations;

  setup(ctx.hexo);
  setup(ctx.hexo);

  assert.strictEqual(ctx.counters.tagRegistrations, before);
});

test('导出的函数可直接接收 hexo 实例（Hexo 加载器方式）', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = makeInstance(root, { enable: true });

  var plugin = require('../index.js');
  assert.strictEqual(typeof plugin, 'function');

  plugin(ctx.hexo);

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
});

test('兼容全局 hexo 变量的加载方式', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = makeInstance(root, { enable: true });

  var modulePath = require.resolve('../index.js');
  var cachedModule = require.cache[modulePath];
  var previousGlobal = global.hexo;

  delete require.cache[modulePath];
  global.hexo = ctx.hexo;
  try {
    require('../index.js');
  } finally {
    global.hexo = previousGlobal;
    delete require.cache[modulePath];
    require.cache[modulePath] = cachedModule;
  }

  assert.strictEqual(typeof ctx.tags.GoogleAdsense, 'function');
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
});

// ---------------------------------------------------------------- 远程文件

test('before_generate 预取远程代码后注入，并复用缓存', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(AD_CODE);
  });

  var ctx = createHexo(root, { enable: true, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(requests, 1);
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('远程地址大小写不敏感', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  var url = host.base.replace('http://', 'HTTP://') + '/ads.html';
  var ctx = createHexo(root, { enable: true, file_path: url });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
});

test('跟随 302 重定向', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ads.html' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  var ctx = createHexo(root, { enable: true, file_path: host.base + '/redirect' });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
});

test('HTTP 404 时返回空内容并记录错误', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  var ctx = createHexo(root, { enable: true, file_path: host.base + '/missing.html' });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), '');
  assert.match(logsOf(ctx, 'error')[0], /HTTP status 404/);
});

test('远程内容不含广告标记时拒绝使用', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>hello</body></html>');
  });

  var ctx = createHexo(root, { enable: true, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), '');
  assert.match(logsOf(ctx, 'error')[0], /content abnormal/);
});

test('远程返回整页 HTML（只有加载脚本）时拒绝使用', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1"></script></head><body>文章</body></html>');
  });

  var ctx = createHexo(root, { enable: true, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), '');
  assert.match(logsOf(ctx, 'error')[0], /content abnormal/);
});

test('HTTPS 地址使用 https 模块下载', async function() {
  var root = createWorkspace();
  var originalGet = https.get;
  var requested = null;

  // 用假的 https.get 模拟一次成功响应，验证协议分派与响应解析
  https.get = function(target, options, callback) {
    requested = String(target);
    var req = new EventEmitter();
    req.destroy = function(err) {
      if (err) req.emit('error', err);
    };
    setImmediate(function() {
      var res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.resume = function() {};
      callback(res);
      res.emit('data', Buffer.from(AD_CODE));
      res.emit('end');
    });
    return req;
  };

  try {
    var ctx = createHexo(root, { enable: true, file_path: 'https://ads.example.com/unit.html' });
    await applyFilter(ctx, 'before_generate');

    assert.strictEqual(requested, 'https://ads.example.com/unit.html');
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
    assert.deepStrictEqual(logsOf(ctx, 'error'), []);
  } finally {
    https.get = originalGet;
  }
});

test('文章里的远程广告地址会在渲染前预取', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  var ctx = createHexo(root, { enable: true });
  var url = host.base + '/post-ad.html';

  // 禁用 curl 兜底，确保广告代码一定来自异步预取
  var childProcess = require('child_process');
  var originalExec = childProcess.execFileSync;
  childProcess.execFileSync = function() {
    throw new Error('synchronous fallback should not be used');
  };

  try {
    var data = { title: '文章', content: "正文\n\n{% GoogleAdsense '" + url + "' %}\n\n结尾" };
    var result = await applyFilter(ctx, 'before_post_render', data);

    assert.strictEqual(result, data);
    assert.strictEqual(requests, 1);
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [url], ''), AD_CODE);
  } finally {
    childProcess.execFileSync = originalExec;
  }

  assert.strictEqual(requests, 1);
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('prefetch 为 async 时不等待下载，未命中缓存则留空', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    setTimeout(function() {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(AD_CODE);
    }, 200);
  });

  var ctx = createHexo(root, { enable: true, prefetch: 'async' });
  var url = host.base + '/slow.html';
  var data = { title: '文章', content: "{% GoogleAdsense '" + url + "' %}" };

  // 用假的 curl 兜底返回值，若插件退化成同步请求会立刻被断言发现
  var childProcess = require('child_process');
  var originalExec = childProcess.execFileSync;
  var syncCalls = 0;
  childProcess.execFileSync = function() {
    syncCalls += 1;
    return AD_CODE;
  };

  try {
    var startedAt = Date.now();
    var result = await applyFilter(ctx, 'before_post_render', data);
    var elapsed = Date.now() - startedAt;

    assert.strictEqual(result, data);
    assert.ok(elapsed < 150, 'async 模式不应等待下载，实际耗时 ' + elapsed + 'ms');
    // 下载还没完成，且不会退化成同步请求
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [url], ''), '');
    assert.strictEqual(syncCalls, 0);

    // 后台预取完成后即可命中缓存
    await new Promise(function(resolve) { setTimeout(resolve, 350); });
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [url], ''), AD_CODE);
    assert.strictEqual(syncCalls, 0);
  } finally {
    childProcess.execFileSync = originalExec;
  }
});

test('prefetch 为 off 时不预取，渲染时按需同步读取', async function() {
  var root = createWorkspace();
  var ctx = createHexo(root, {
    enable: true,
    prefetch: 'off',
    file_path: 'https://ads.example.com/default.html'
  });
  var url = 'https://ads.example.com/post.html';

  var childProcess = require('child_process');
  var originalExec = childProcess.execFileSync;
  var requested = [];
  childProcess.execFileSync = function(command, args) {
    requested.push(args[args.length - 1]);
    return AD_CODE;
  };

  try {
    await applyFilter(ctx, 'before_generate');
    await applyFilter(ctx, 'before_post_render', { title: '文章', content: "{% GoogleAdsense '" + url + "' %}" });
    assert.deepStrictEqual(requested, [], 'off 模式不应发起预取');

    // 渲染时才同步读取（curl 兜底）
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [url], ''), AD_CODE);
    assert.deepStrictEqual(requested, [url]);
    assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
    assert.strictEqual(requested.length, 2);
  } finally {
    childProcess.execFileSync = originalExec;
  }
});

test('prefetch 为 false 等同于 off', async function() {
  var root = createWorkspace();
  var childProcess = require('child_process');
  var originalExec = childProcess.execFileSync;
  var calls = 0;
  childProcess.execFileSync = function() {
    calls += 1;
    return AD_CODE;
  };

  try {
    var ctx = createHexo(root, { enable: true, prefetch: false, file_path: 'https://ads.example.com/a.html' });
    await applyFilter(ctx, 'before_generate');
    assert.strictEqual(calls, 0);
  } finally {
    childProcess.execFileSync = originalExec;
  }
});

test('非法 prefetch 值回退默认 wait 并告警', function() {
  var root = createWorkspace();
  writeAds(root, 'source/ads/google/article_ads.html', AD_CODE);
  var ctx = createHexo(root, { enable: true, prefetch: 'sometimes' });

  assert.strictEqual(logsOf(ctx, 'warn').length, 1);
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);

  // 数字写法同样视为非法，不会映射成 wait/off
  var numeric = createHexo(root, { enable: true, prefetch: 1 });
  assert.strictEqual(logsOf(numeric, 'warn').length, 1);
  assert.match(logsOf(numeric, 'warn')[0], /Invalid prefetch/);
});

test('非 http/https 协议给出明确错误而不是当成文件路径', function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, file_path: 'ftp://example.com/ads.html' });

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
  assert.match(logsOf(ctx, 'error')[0], /Unsupported protocol/);
});

test('失败过的远程地址在冷却时间内不会逐篇重复请求', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  var ctx = createHexo(root, { enable: true });
  var content = "{% GoogleAdsense '" + host.base + "/missing.html' %}";

  // 两篇文章引用同一个失效地址，只应产生一次请求、一条错误日志
  await applyFilter(ctx, 'before_post_render', { title: '文章 A', content: content });
  await applyFilter(ctx, 'before_post_render', { title: '文章 B', content: content });

  assert.strictEqual(requests, 1);
  assert.strictEqual(logsOf(ctx, 'error').length, 1);
});

test('cache_ttl 过期后重新预取', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  var ctx = createHexo(root, { enable: true, cache_ttl: 1, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');
  await new Promise(function(resolve) { setTimeout(resolve, 20); });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(requests, 2);
});

test('timeout 配置为布尔值等非法类型时回退默认值', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    setTimeout(function() {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(AD_CODE);
    }, 80);
  });

  // timeout: true 若被当成数字会变成 1ms，导致本次请求超时
  var ctx = createHexo(root, { enable: true, timeout: true, file_path: host.base + '/slow.html' });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], ''), AD_CODE);
  assert.deepStrictEqual(logsOf(ctx, 'error'), []);
});

test('cache_ttl 配置为布尔值等非法类型时回退默认值', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  // cache_ttl: true 若被当成数字会变成 1ms，导致第二次预取重新下载
  var ctx = createHexo(root, { enable: true, cache_ttl: true, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');
  await new Promise(function(resolve) { setTimeout(resolve, 20); });
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(requests, 1);
});

test('cache_ttl 为 0 表示进程内永不过期', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  var ctx = createHexo(root, { enable: true, cache_ttl: 0, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(requests, 1);
});

test('请求超时会失败退让，不会拖死构建', async function() {
  var root = createWorkspace();
  var host = await startServer(function(req, res) {
    res.writeHead(200, { 'content-type': 'text/html' });
    // 故意不结束响应
  });

  var ctx = createHexo(root, { enable: true, timeout: 50, file_path: host.base + '/slow.html' });
  var startedAt = Date.now();
  await applyFilter(ctx, 'before_generate');
  var elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 2000, '预取应该在超时后结束，实际耗时 ' + elapsed + 'ms');
  assert.match(logsOf(ctx, 'error')[0], /timed out/);
  assert.strictEqual(renderTag(ctx, 'GoogleAdsense', [], '原文'), '原文');
});

test('cache 为 false 时每次生成都重新预取', async function() {
  var root = createWorkspace();
  var requests = 0;
  var host = await startServer(function(req, res) {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_CODE);
  });

  var ctx = createHexo(root, { enable: true, cache: false, file_path: host.base + '/ads.html' });
  await applyFilter(ctx, 'before_generate');
  await applyFilter(ctx, 'before_generate');

  assert.strictEqual(requests, 2);
});

// ---------------------------------------------------------------- 日志过滤器

test('log_msg 开启时对包含标签的文章输出日志', async function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, log_msg: true });

  await applyFilter(ctx, 'before_post_render', { title: '文章 A', content: '正文 {% GoogleAdsense %} 结束' });
  await applyFilter(ctx, 'before_post_render', { title: '文章 B', content: '正文 {%GoogleAdsense%} 结束' });
  await applyFilter(ctx, 'before_post_render', { title: '文章 C', content: '正文 {% GoogleAdsense%} 结束' });
  await applyFilter(ctx, 'before_post_render', { title: '文章 D', content: '正文 {% GoogleAdsense "ads/a.html" %} 结束' });
  await applyFilter(ctx, 'before_post_render', { title: '文章 E', content: '没有标签的文章' });

  var infos = logsOf(ctx, 'info');
  assert.strictEqual(infos.length, 4);
  assert.match(infos[0], /文章 A/);
  // 受支持的写法不应产生告警
  assert.deepStrictEqual(logsOf(ctx, 'warn'), []);
});

test('日志过滤器能识别带 % 编码参数的标签', async function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, log_msg: true });

  await applyFilter(ctx, 'before_post_render', {
    title: '文章 F',
    content: "{% GoogleAdsense 'ads/a%20b.html' %}"
  });

  assert.strictEqual(logsOf(ctx, 'info').length, 1);
  assert.match(logsOf(ctx, 'info')[0], /文章 F/);
});

test('日志过滤器不会把相似标签名误判为广告标签', async function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, log_msg: true });

  await applyFilter(ctx, 'before_post_render', { title: '文章 G', content: '{% GoogleAdsense2 %}' });

  assert.deepStrictEqual(logsOf(ctx, 'info'), []);
});

test('log_msg 关闭或插件禁用时保持静默', async function() {
  var root = createWorkspace();

  var quiet = createHexo(root, { enable: true, log_msg: false });
  await applyFilter(quiet, 'before_post_render', { title: '文章', content: '{% GoogleAdsense %}' });

  var disabled = createHexo(root, { enable: false, log_msg: true });
  await applyFilter(disabled, 'before_post_render', { title: '文章', content: '{% GoogleAdsense %}' });

  assert.deepStrictEqual(logsOf(quiet, 'info'), []);
  assert.deepStrictEqual(logsOf(disabled, 'info'), []);
});

test('过滤器返回原始数据，不会破坏渲染流程', async function() {
  var root = createWorkspace();
  var ctx = createHexo(root, { enable: true, log_msg: true });
  var data = { title: '文章', content: '{% GoogleAdsense %}' };

  assert.strictEqual(await applyFilter(ctx, 'before_post_render', data), data);
});
