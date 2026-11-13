## Hexo 的谷歌广告插件

### 用途说明

支持使用 Hexo 自定义标签将谷歌广告代码动态插入到指定的文章的特定位置中，广告类型一般是谷歌的文章内嵌广告，但也支持谷歌其他类型的广告。广告代码可以放在本地文件中，也可以放在网络上（同时支持 **HTTP** 和 **HTTPS**），插件会自动读取并缓存到本地。

### 使用步骤

1. 安装插件：`npm install hexo-google-adsense --save`
2. 编辑 Hexo 的 `_config.yml` 配置文件，添加对应的插件配置信息
3. 在本地或网络上创建存放谷歌广告代码的文件，并拷贝谷歌的广告代码到文件中
4. 编辑 Hexo 的 MarkDown 文件（即文章内容），在希望添加谷歌广告的地方，插入右边这行内容即可： `{% GoogleAdsense %}`

### 标签写法

往 Hexo 的 MarkDown 文件（即文章内容）插入谷歌广告时，支持下面三种标签写法，效果互相等价：

| 写法                  | 是否支持 | 说明                 |
|-----------------------|----------|----------------------|
| `{% GoogleAdsense %}` | ✅        | 推荐写法，独占一行   |
| `{%GoogleAdsense%}`   | ✅        | 标签内不加空格也可以 |
| `{% GoogleAdsense%}`  | ✅        | 只在一侧加空格也可以 |

注意点：

- **标签名的来源**：`{% GoogleAdsense %}` 中的 `GoogleAdsense` 是 Hexo 自定义标签默认的名称，依赖 `tag_name` 配置。
- **标签名区分大小写**：`{% googleadsense %}`、`{% GOOGLEADSENSE %}` 会报 `unknown block tag`，必须和 `tag_name` 配置完全一致；`{% GoogleAdsense2 %}` 这类拼写错误同样会直接报错，而不是静默失败。

### 配置示例

``` yml
hexo_google_adsense:
  enable: true
  log_msg: true
  timeout: 15000
  prefetch: wait
  cache: true
  cache_ttl: 3600000
  tag_name: 'GoogleAdsense'
  file_path: 'source/ads/google/article_ads.html'
```

### 参数说明

| 参数          | 默认值                               | 说明                                                                                                                       |
|---------------|--------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| **enable**    | `false`                              | 是否启用插件。为 `false` 时标签仍然注册，只是不插入广告代码，避免文章里的标签被当成未知标签而渲染报错                      |
| **log_msg**   | `false`                              | 是否在构建时打印「哪篇文章插入了广告代码」的日志                                                                           |
| **tag_name**  | `GoogleAdsense`                      | Hexo 自定义标签的名称，不能包含空白字符，否则会回退为默认值并给出警告                                                      |
| **file_path** | `source/ads/google/article_ads.html` | 广告代码文件的路径，支持绝对路径、相对 Hexo 根目录的路径、相对 `source` 目录的路径，以及 `http://` / `https://` 开头的 URL |
| **cache**     | `true`                               | 是否缓存广告代码文件的读取结果。本地文件按修改时间（mtime）自动失效；远程文件按 `cache_ttl` 失效                           |
| **cache_ttl** | `3600000`                            | 远程广告代码文件的缓存时间（毫秒），`0` 表示本次 Hexo 进程内永不过期                                                       |
| **timeout**   | `15000`                              | 远程广告代码文件的请求超时时间（毫秒）                                                                                     |
| **prefetch**  | `wait`                               | 远程广告代码文件的预取模式：`wait` / `async` / `off`                                                                       |

### 预取模式（prefetch）

`prefetch` 决定远程广告代码文件在什么时候下载，直接影响 Hexo 构建耗时与产物完整性：

| 取值           | 行为                                                                                        | 构建耗时                 | 产物广告                                       |
|----------------|---------------------------------------------------------------------------------------------|--------------------------|------------------------------------------------|
| `wait`（默认） | `before_generate` / `before_post_render` 预取并**等待**下载完成；缓存未命中时用 `curl` 兜底 | 每个唯一地址最多一次往返 | 完整                                           |
| `async`        | 只发起后台预取，渲染**不等待**；缓存未命中时该广告位留空，也不会调用 `curl`                 | 几乎不受影响             | 首次构建可能缺失广告；`hexo server` 预热后正常 |
| `off`          | 完全不预取，渲染时才用 `curl` 同步读取                                                      | 首次使用同步阻塞         | 完整，但依赖 `curl`                            |

配置建议：

- 一般保持默认 `wait`：`hexo generate` 每次都是独立进程、没有跨构建缓存，只有等待才能保证发布产物里广告完整。
- 本地预览想快一点可以用 `async`：内存缓存命中后（首次构建之后）广告会出现，代价是首次构建/重启后第一轮可能没有广告。
- `off` 适合不希望插件在构建阶段发起后台请求、或已经用其它方式预热缓存的环境。

> 注意：`async` 模式下**不会**退回同步 `curl`，所以 `hexo generate` 每次都是新进程时，远程广告基本不会出现在产物里。除非确认是预览场景，否则不要用它替代默认值。

### 远程广告代码下载

- **协议兼容**：`http://` 和 `https://` 协议都支持，由 Node 原生 `http` / `https` 模块下载，不额外依赖第三方库。
- **HTTPS 证书**：使用 Node 默认的 TLS 校验。自签名、已过期或域名不匹配的证书会下载失败并在日志中说明原因；内网自签名证书可以通过环境变量 `NODE_EXTRA_CA_CERTS` 指定 CA 证书。
- **安全校验**：只接受 HTTP 200 响应；最多跟随 5 次重定向（支持 `http` 与 `https` 之间跳转）；响应体上限 1 MB；内容必须包含 `data-ad-client` 或 `data-ad-slot`，否则视为异常内容（例如拿到 404 页面或登录页）而拒绝使用。
- **失败退让**：下载失败、超时或内容异常时只记录错误，页面照常生成，不会中断构建。
- **缓存与兜底**：下载成功的内容会缓存；如果渲染时缓存仍为空，会调用系统 `curl` 同步获取一次（`curl` 在 Windows 10 1803+ / macOS / 主流 Linux 发行版中默认可用）。没有安装 `curl` 时只会打印一条错误日志。

### 不同文章插入不同的广告

标签支持带一个参数，用来指定本篇文章使用的广告代码文件（既可以是本地文件，也可以是 HTTP/HTTPS 地址），参数需要用单引号包裹：

``` markdown
{% GoogleAdsense 'source/ads/google/sidebar_ads.html' %}
{% GoogleAdsense 'https://www.example.com/ads/google/article_ads.html' %}
```

> 关于单引号：Hexo 会把标签参数按空白切分成原始字符串（不做表达式求值），所以 `ads/google/a.html`、`https://...` 这类不加单引号的参数也能正常工作；但**路径或 URL 里含空格时必须加单引号**，否则会被切成多个参数、插件只取第一个。建议统一加单引号避免歧义。

### 实现细节与性能优化

- **本地广告文件按 mtime 缓存**：同一个文件在一次构建中只会读取一次，文件改动后自动重新读取（`cache: false` 可关闭缓存）。
- **远程广告文件预取（异步并发）**：
  - `before_generate` 阶段预取配置里的 `file_path`（当它是 HTTP/HTTPS 地址时）；
  - `before_post_render` 阶段扫描本篇文章用到的远程地址并预取，多个地址并行下载，同一地址的并发请求会合并；
  - 文章级预取的等待行为由 `prefetch` 控制：`wait`（默认）等下载完成再渲染该文章，`async` 只后台下载、不等待渲染，`off` 不预取；由于同一地址只下载一次，`wait` 实际只多出一次网络往返（不影响其它文章并行渲染）；
  - 预取失败、超时、返回非 200、内容异常时只记录错误并退让，不会中断构建；失败过的地址在 1 分钟内不会重复请求，避免逐篇等待超时。
- **同步兜底**：`wait` / `off` 模式下，如果渲染时远程代码还没准备好，会调用系统 `curl` 同步获取一次；没有安装 `curl` 时只记录错误，页面照常生成（`async` 模式不做同步读取）。
- **错误去重**：同一条错误在 1 分钟内只打印一次，避免每篇文章刷屏。
- **标签识别**：日志判断只认受支持的写法（`{% GoogleAdsense %}`、`{%GoogleAdsense%}`、`{% GoogleAdsense%}` 以及带参数的写法），不会把 `{% GoogleAdsense2 %}` 这类相似标签误判进来。

### 注意事项

根据谷歌官方的要求，使用此插件时必须在 Hexo 主题的模板文件中的 Head 标签内添加如下一行代码（**请自行替换掉 xxxxx 为你自己的 Google AdSense 发布商 ID**）：

``` js
<head>
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-xxxxx" crossorigin="anonymous"></script>
</head>
```

### 常见问题

- **文章页面里没有广告**：确认 `enable: true`，并检查 `file_path` 指向的文件是否存在、内容是否包含 `data-ad-client` / `data-ad-slot`。构建日志里会有对应提示。
- **远程广告文件读取失败**：插件会校验 HTTP 状态码与内容特征，404、登录页、错误页都会被拒绝，并打印具体原因。
- **HTTPS 报错 `self-signed certificate` / `unable to verify the first certificate` / `CERT_HAS_EXPIRED`**：说明对方证书不被 Node 信任、已过期或域名不匹配。请换用受信任的证书，或通过 `NODE_EXTRA_CA_CERTS` 指定自签名 CA。
- **日志提示 `curl is not available`**：说明渲染时缓存尚未准备好，且系统没有 `curl`。通常只需保证预取成功（网络可访问、`timeout` 足够大）即可，或自行安装 `curl`。
- **配置成 `ftp://` 等协议**：插件只支持 HTTP/HTTPS，会给出 `Unsupported protocol` 错误，不会把它误当成文件路径。
- **Hexo 构建报 `unknown block tag`**：标签名拼写或大小写与 `tag_name` 不一致（例如写成 `{% googleadsense %}`、`{% GoogleAdsense2 %}`），Hexo 会直接报错而不是忽略；请按「标签写法」一节核对。
- **Hexo 构建太慢 / 想更快**：把 `prefetch` 设为 `async` 可让构建不等待下载（产物可能缺广告），设为 `off` 则改为按需同步读取，详见「预取模式」。

### 开发与测试

``` bash
# 安装依赖
npm install

# 执行测试
npm test
```

测试使用 Node 内置的 `node:test`，不依赖 Hexo 本体：用 mock 的 Hexo 实例和本地 HTTP 服务覆盖本地文件、HTTP 下载、HTTPS 协议分派、缓存、超时、重定向、内容校验、三种 `prefetch` 模式、日志与两种插件加载方式。需要 Node.js 18 及以上版本。
