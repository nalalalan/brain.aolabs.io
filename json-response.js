'use strict';
const {gzipSync}=require('node:zlib');
module.exports=function encodeJson(payload,acceptEncoding=''){
 const text=JSON.stringify(payload),acceptsGzip=String(acceptEncoding).split(',').some(v=>/^gzip(?:\s*;|\s*$)/i.test(v.trim())&&!/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(v));
 if(text.length<16384||!acceptsGzip)return {body:text,headers:{}};
 return {body:gzipSync(text,{level:1}),headers:{'Content-Encoding':'gzip','Vary':'Accept-Encoding'}};
};
