// Minimal DOM stub: enough to let index.html's script body evaluate so the real
// costing functions can be exercised in Node.
const fs = require('fs'), vm = require('vm'), path = require('path');
function El(id){
  return { id, value:'', textContent:'', innerHTML:'', style:{setProperty(){}}, dataset:{}, checked:false,
    className:'', classList:{add(){},remove(){},toggle(){},contains(){return false}},
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){}, replaceWith(){},
    setAttribute(){}, getAttribute(){return null}, focus(){}, querySelector(){return null},
    querySelectorAll(){return []}, children:[], colSpan:0, lastChild:null, files:[] };
}
const cache = {};
const document = {
  getElementById: id => (cache[id] || (cache[id] = El(id))),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: t => El(t),
  documentElement: El('html'),
  addEventListener(){}, body: El('body')
};
const window = { location:{href:'https://x/y', origin:'https://x', pathname:'/y'}, addEventListener(){} };
const ctx = { document, window, console, setTimeout, clearTimeout, Math, JSON, Date, Number, String,
  Array, Object, Promise, parseFloat, parseInt, isNaN, fetch: async()=>({ok:false,status:404}),
  alert(){}, confirm(){return false}, Image: function(){}, FileReader: function(){}, XLSX:{}, msal:undefined };
ctx.window = window; ctx.globalThis = ctx; ctx.self = ctx;

const html = fs.readFileSync(process.argv[2],'utf8');
const b = html.lastIndexOf('<script>'), e = html.lastIndexOf('</script>');
vm.createContext(ctx);
// const/let stay in the script's lexical scope and never land on the context object,
// so ask the script itself to hand them out.
const src = html.slice(b+8, e) + "\n;globalThis.__x = {state, PROC_COLS, computePart, activeRates, cloneRates, masterRatesView, num, roundUpTo10, esc, collectQuoteData, quoteGrandTotal};";
vm.runInContext(src, ctx, {filename:'app.js'});
module.exports = ctx.__x;
