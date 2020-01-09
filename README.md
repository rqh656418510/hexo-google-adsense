#### 用途说明
通过自定义标签将谷歌广告代码插入到Hexo的文章中，广告类型一般是谷歌的文章内嵌广告，但也支持谷歌其他类型广告（用户阅读体验较差）。

#### 使用说明：
1. 安装插件：npm install hexo-google-adsense --save
2. 在本地目录或网络上创建存放谷歌广告代码的文件，并拷贝谷歌的广告代码到文件中
3. 编辑_config.yml文件，添加对应的插件配置信息
4. 编辑Hexo的MarkDown文件，在希望添加谷歌广告的地方，增加一行内容即可： {% GoogleAdsense %}

#### 配置示例

``` yml
google_adsense:
  enable: true

hexo_google_adsense:
  enable: true
  file_path: 'source/ads/google/article_ads.txt'
```

#### 参数说明
- google_adsense.enable: 是否全局启用谷歌广告
- hexo_google_adsense.enable： 是否启用谷歌广告插件
- hexo_google_adsense.file_path： 存放谷歌广告代码的文件，支持使用绝对路径或者相对于Hexo根目录的路径，同时支持使用URL路径（例如：https://www.example.com/ads/google/article_ads.txt）

#### 注意事项
1. 根据谷歌官方的要求，使用此插件时需要提前在Hexo主题的模板文件中的Head标签内添加一行代码，具体配置内容如下（请自行替换掉 xxxxxxx）。

``` js
<head>
  <script data-ad-client="xxxxxxx" async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
</head>
```

#### 待优化功能
1. 目前只能在_config.yml文件中配置单一类型的谷歌广告，后续考虑结合Hexo自定义标签的参数，支持在文章中插入不同类型的广告
