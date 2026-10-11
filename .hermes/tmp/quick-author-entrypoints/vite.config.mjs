import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default {root:fileURLToPath(new URL('.',import.meta.url)),plugins:[vue(),{name:'fixture-health',configureServer(server){server.middlewares.use('/health',(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,isolated:true,productionApi:false}));});}}],server:{host:'127.0.0.1',port:18742,strictPort:true,fs:{allow:[fileURLToPath(new URL('../../../',import.meta.url))]}}};
