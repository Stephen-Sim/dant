import {defineConfig} from 'vite';
export default defineConfig({root:'ui',server:{host:'127.0.0.1',port:4318,strictPort:true,proxy:{'/api':'http://127.0.0.1:4317','/events':{target:'ws://127.0.0.1:4317',ws:true}}},build:{outDir:'../dist',emptyOutDir:true,rollupOptions:{input:{main:'ui/index.html',callOverlay:'ui/call-overlay.html'}}}});
