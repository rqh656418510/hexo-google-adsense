'use strict';

var fs = require('fs');
var path = require('path');
var process = require('child_process');
var log = require('hexo-log')({name: 'hexo-google-adsense', debug: false});

var default_tag_name = "GoogleAdsense";
var default_file_path = "source/ads/google/article_ads.html";

var config = hexo.config;
var adsense_config = config.hexo_google_adsense;
var enable = adsense_config ? adsense_config.enable : false;
var log_msg = adsense_config ? adsense_config.log_msg : false;
var tag_name = adsense_config ? adsense_config.tag_name : default_tag_name;
var file_path = adsense_config ? adsense_config.file_path : default_file_path;

// 自定义标签的名称
if(!tag_name || tag_name.trim() === ""){
  tag_name = default_tag_name;
}

// 文件路径
if(!file_path || file_path.trim() === ""){
  file_path = default_file_path;
}

// 是否为网址URL
function isWebUrl(str){
  if(str.substr(0,7).toLowerCase() == "http://" || str.substr(0,8).toLowerCase() == "https://"){
    return true;
  }
  return false;
}

// 判断文件是否存在
function fsExistsSync(path) {
    try{
        fs.accessSync(path, fs.F_OK);
    }catch(e){
        return false;
    }
    return true;
}

// 通过本地文件获取广告代码
function getLocalAdsCode(path){
    try{
      return fs.readFileSync(path, 'utf8');
    }catch(e){
      log.error("Read google adsense file failed");
    }
    return "";
}

// 通过Http请求获取广告代码
function getRemoteAdsCode(path){
    try{
        // 读取网络文件（同步操作）
        var content = process.execFileSync('curl', ['--silent', '-L', path], {encoding: 'utf8'});
        // 判断网络文件的内容是否正确
        if(content.indexOf("data-ad-client") != -1 && content.indexOf("data-ad-slot") != -1){
          return content;
        }
        else{
          log.error("Google adsense file content abnormal");
        }
    }catch(e){
      log.error("Read google adsense file failed");
    }
    return "";
}

// 获取广告代码
function getAdsCode(path){
    if(isWebUrl(path)){
        return getRemoteAdsCode(path);
    }
    return getLocalAdsCode(path);
}

// 插入广告代码
function insertAds(args, content) {
    if(enable){
        var adsCode = getAdsCode(file_path).trim();
        return adsCode == '' ? content : adsCode;
    }
    return content;
}

// 注册标签
hexo.extend.tag.register(tag_name, insertAds);

// 注册过滤器
hexo.extend.filter.register('before_post_render', function test(data){
  if(enable && log_msg){
      var tag = "{% " + tag_name + " %}";
      if(data.content.indexOf(tag) != -1){
          log.info("Insert google adsense code for blog: " + data.title);
      }
  }
  return data;
});
