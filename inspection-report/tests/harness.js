// Minimal DOM stub, same idea as ../../tests/harness.js: enough for the app's
// script body to evaluate in Node so the metrology engine and the audit rules
// can be exercised without a browser.
//
// document.querySelector returns null here, which is what stops the app from
// booting — see the guard at the foot of index.html.
const fs = require('fs'), vm = require('vm');

function El(id){
  return { id, value:'', textContent:'', innerHTML:'', dataset:{}, checked:false, hidden:false,
    className:'', style:{ setProperty(){} }, classList:{ add(){}, remove(){}, toggle(){}, contains(){ return false } },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){}, remove(){},
    setAttribute(){}, getAttribute(){ return null }, closest(){ return null }, focus(){}, click(){}, select(){},
    querySelector(){ return null }, querySelectorAll(){ return [] }, showModal(){}, close(){},
    children:[], colSpan:0, rows:0, files:[], clientWidth:800, offsetWidth:794, offsetHeight:1123 };
}

const cache = {};
const document = {
  getElementById: id => (cache[id] || (cache[id] = El(id))),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: t => El(t),
  documentElement: El('html'),
  readyState: 'complete',
  addEventListener(){},
  body: El('body')
};
const window = { addEventListener(){}, location:{ href:'https://x/', origin:'https://x' } };

const ctx = { document, window, console, setTimeout, clearTimeout, Math, JSON, Date, Number, String,
  Array, Object, Boolean, RegExp, Error, parseFloat, parseInt, isNaN, isFinite,
  alert(){}, confirm(){ return true }, Image: function(){}, FileReader: function(){} };
ctx.window = window; ctx.globalThis = ctx; ctx.self = ctx;

const html = fs.readFileSync(process.argv[2], 'utf8');
const b = html.lastIndexOf('<script>'), e = html.lastIndexOf('</script>');
vm.createContext(ctx);
vm.runInContext(html.slice(b + 8, e), ctx, { filename:'datum.js' });

module.exports = ctx.__datum;
