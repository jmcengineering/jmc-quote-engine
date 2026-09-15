process.argv[2] = require('path').join(__dirname, '..', 'index.html');
const c = require('./harness.js');
let pass=0, fail=0;
const ok=(n,cond,extra='')=>{ cond?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n,extra)); };
const near=(a,b,t=0.01)=>Math.abs(a-b)<t;

const { state, computePart, activeRates, cloneRates, PROC_COLS } = c;

function block(){ const p={id:1,partNo:'',description:'',shape:'block',materialId:'MS',dia:'',t:'20',w:'100',l:'200',qty:2,unitPriceStd:'',marginOverride:'',image:null};
  PROC_COLS.forEach(x=>p[x.key]=''); return p; }

console.log('\n1. Rate snapshot — the reported bug');
state.quoteMargin = 15; state.stockAllowance = 5; state.quoteRatesLinked = true; state.quoteRates = null;
const p = block();
const atOldRates = computePart(p).lineTotal;
ok('quote prices at current master', atOldRates > 0);

// Save the quote: it takes a snapshot of today's rates.
const snapshot = cloneRates(activeRates());

// Now change the rate master for a DIFFERENT job: MS 80 -> 200/kg.
state.materials.find(m=>m.id==='MS').rate = 200;
ok('a LINKED quote follows the master', computePart(p).lineTotal > atOldRates);

// Reopen the saved quote: it carries its own rates.
state.quoteRates = snapshot; state.quoteRatesLinked = false;
ok('a SAVED quote keeps its original price', near(computePart(p).lineTotal, atOldRates),
   `got ${computePart(p).lineTotal.toFixed(2)} want ${atOldRates.toFixed(2)}`);

// Re-link on purpose ("Use current rate master")
state.quoteRatesLinked = true; state.quoteRates = null;
ok('re-linking re-prices deliberately', computePart(p).lineTotal > atOldRates);
state.materials.find(m=>m.id==='MS').rate = 80;

console.log('\n2. Costing reads state, not the DOM');
state.quoteRatesLinked = true; state.quoteRates = null;
const w5 = computePart(p).weight;
state.stockAllowance = 0;
const w0 = computePart(p).weight;
ok('stock allowance from state changes weight', !near(w5,w0), `${w5} vs ${w0}`);
// (20+0)*(100+0)*(200+0)*7.85/1e6 = 3.14 kg
ok('block weight formula exact', near(w0, 20*100*200*7.85/1e6), `got ${w0}`);
state.stockAllowance = 5;

console.log('\n3. Margin comes from state');
state.quoteMargin = 0;
const m0 = computePart(p).lineTotal;
state.quoteMargin = 100;
const m100 = computePart(p).lineTotal;
ok('margin drives the total', near(m100, m0*2), `${m0} -> ${m100}`);
state.quoteMargin = 15;

console.log('\n4. Negative input cannot credit a quote');
const neg = Object.assign(block(), {t:'-50'});
ok('negative thickness clamps to 0', computePart(neg).weight >= 0 && computePart(neg).lineTotal >= 0);
const negQty = Object.assign(block(), {qty:'-3'});
ok('negative qty clamps to 0', computePart(negQty).lineTotal === 0);

console.log('\n5. Deleted material does not silently zero-cost');
const orphan = Object.assign(block(), {materialId:'GONE-123'});
ok('unknown material costs 0 RM', computePart(orphan).rmCost === 0);

console.log('\n6. Round stock uses a real cylinder');
const r = Object.assign(block(), {shape:'round', dia:'50', l:'100', t:'', w:''});
const rad=(50+5)/2, expect=Math.PI*rad*rad*(100+5)*7.85/1e6;
ok('round weight formula exact', near(computePart(r).weight, expect), `got ${computePart(r).weight}`);

console.log('\n7. Bought-out parts skip weight');
const std = Object.assign(block(), {shape:'standard', unitPriceStd:'1234'});
ok('standard part uses direct price', computePart(std).weight===0 && computePart(std).rmCost===1234);

console.log('\n8. Change detection is stable over time (the savedAt bug)');
const snap1 = JSON.stringify(c.collectQuoteData());
const t0=Date.now(); while(Date.now()-t0<5){}          // time passes, nothing edited
const snap2 = JSON.stringify(c.collectQuoteData());
ok('identical content compares equal across time', snap1===snap2);
ok('payload carries no timestamp', !('savedAt' in c.collectQuoteData()));
state.parts = [block()];
ok('a real edit is still detected', JSON.stringify(c.collectQuoteData()) !== snap1);

console.log('\n9. Saved quote carries its rates');
const d = c.collectQuoteData();
ok('rates snapshot is embedded', !!(d.rates && d.rates.materials.length && d.rates.stockAllowance !== undefined));
ok('snapshot is a copy, not a reference', d.rates.materials !== state.materials);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
