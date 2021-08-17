## Hexo 的谷歌广告插件

### 用途说明

支持使用 Hexo 自定义标签将谷歌广告代码动态插入到指定的文章的特定位置中，广告类型一般是谷歌的文章内嵌广告，但也支持谷歌其他类型的广告。

### 使用步骤

1. 安装插件：`npm install hexo-google-adsense --save`
2. 编辑 Hexo 的 `_config.yml` 配置文件，添加对应的插件配置信息
3. 在本地或网络上创建存放谷歌广告代码的文件，并拷贝谷歌的广告代码到文件中
4. 编辑 Hexo 的 MarkDown 文件，在希望添加谷歌广告的地方，增加右边这行内容即可： `{% GoogleAdsense %}`

> 提示： `{% GoogleAdsense %}` 中的 `GoogleAdsense` 是 Hexo 自定义标签默认的名称

### 配置示例

``` yml
hexo_google_adsense:
  enable: true
  log_msg: true
  tag_name: 'GoogleAdsense'
  file_path: 'source/ads/google/article_ads.html'
```

### 参数说明

- **enable**： 是否启用插件，默认值为： `false`
- **log_msg**： 是否打印日志信息，默认值为： `false`
- **tag_name**： Hexo 自定义标签的名称，默认值为： `GoogleAdsense`
- **file_path**： 谷歌广告代码文件的路径，支持使用绝对路径或者相对于 Hexo 博客根目录的路径（例如： `source/ads/google/article_ads.html`），同时支持使用 URL 路径（例如： `https://www.example.com/ads/google/article_ads.html`）

### 注意事项

根据谷歌官方的要求，使用此插件时必须在 Hexo 主题的模板文件中的 Head 标签内添加如下的一行代码（请自行替换掉 xxxx）：

``` js
<head>
  <script data-ad-client="xxxx" async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
</head>
```

### 待优化功能

目前只支持在 Hexo 的 `_config.yml` 文件中配置单一类型的谷歌广告，后续考虑结合 Hexo 自定义标签的参数，支持在不同的文章中插入不同类型的广告。
