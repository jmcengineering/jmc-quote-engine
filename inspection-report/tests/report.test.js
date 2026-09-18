process.argv[2] = require('path').join(__dirname, '..', 'index.html');
const d = require('./harness.js');

let pass = 0, fail = 0;
const ok = (n, cond, extra='') => { cond ? (pass++, console.log('  PASS', n))
                                         : (fail++, console.log('  FAIL', n, extra)); };
const near = (a, b, t=1e-9) => a !== null && Math.abs(a - b) < t;

const { calc, audit, num, parseValues, parsePasted, decimalsFor, demoState } = d;
const C = (nominal, upper, lower, U) => ({ nominal, upper, lower, U });

console.log('\n1. Number parsing — CMM printouts are full of junk');
ok('plain number', num('15.6100') === 15.61);
ok('units stripped', num('15.6100 mm') === 15.61);
ok('comma decimal (German CALYPSO)', num('15,6100') === 15.61);
ok('n.def. is not a number', num('n.def.') === null);
ok('blank is null', num('') === null);
ok('a lone dash is null', num('-') === null);
ok('zero survives', num(0) === 0 && num('0') === 0);
ok('multi-piece split', JSON.stringify(parseValues('15.61, 15.60  15.62')) === '[15.61,15.6,15.62]');

console.log('\n2. Limits and deviation');
let c = C('15.5900', '0.0050', '-0.0050');
ok('UTL', near(calc.limits(c).utl, 15.595));
ok('LTL', near(calc.limits(c).ltl, 15.585));
ok('band', near(calc.limits(c).band, 0.01));
ok('deviation is measured minus nominal', near(calc.deviation('15.6100', '15.5900'), 0.02));
const asym = C('20.000', '0.021', '0.000');            // a bored H7 hole
ok('asymmetric UTL', near(calc.limits(asym).utl, 20.021));
ok('asymmetric LTL', near(calc.limits(asym).ltl, 20.000));

console.log('\n3. Verdicts — simple acceptance (U = 0)');
ok('inside passes', calc.verdict(15.590, c) === 'pass');
ok('outside fails', calc.verdict(15.610, c) === 'fail');
ok('exactly on the limit passes', calc.verdict(15.595, c) === 'pass');
ok('no value gives no verdict', calc.verdict('', c) === 'none');

console.log('\n4. Verdicts — stringent acceptance, ISO 14253-1 guard band');
const g = C('15.5900', '0.0050', '-0.0050', '0.0020');  // U = 2 um
ok('well inside still passes', calc.verdict(15.5900, g) === 'pass');
ok('inside the limit but within U is not decidable', calc.verdict(15.5945, g) === 'conditional');
ok('just outside the limit is not decidable', calc.verdict(15.5960, g) === 'conditional');
ok('outside by more than U fails', calc.verdict(15.5980, g) === 'fail');
ok('guard band shrinks the accept zone', calc.verdict(15.5945, c) === 'pass'
   && calc.verdict(15.5945, g) === 'conditional');

console.log('\n5. Out-by and tolerance consumption');
ok('inside is out by zero', calc.outBy(15.590, c) === 0);
ok('over the top', near(calc.outBy(15.610, c), 0.015));
ok('under the bottom', near(calc.outBy(15.580, c), -0.005));
ok('half the plus tolerance', near(calc.pctOfTol(15.5925, c), 50, 1e-6));
ok('all of the minus tolerance', near(calc.pctOfTol(15.5850, c), -100, 1e-6));

console.log('\n6. Statistics and capability');
const vals = [10.002, 10.001, 9.999, 10.000, 9.998];
const st = calc.stats(vals);
ok('n', st.n === 5);
ok('mean', near(st.mean, 10.0, 1e-9));
ok('range', near(st.range, 0.004, 1e-9));
ok('sample sd uses n-1', near(st.sd, 0.0015811, 1e-6));
const cap = calc.capability(vals, C('10.000', '0.010', '-0.010'));
ok('Cp computed', near(cap.cp, 0.010 * 2 / (6 * st.sd), 1e-6));
ok('centred process: Cpk = Cp', near(cap.cpk, cap.cp, 1e-6));
ok('one piece gives no capability', calc.capability([10.0], C('10','0.01','-0.01')).cpk === null);
const off = calc.capability([10.008, 10.009, 10.007], C('10.000', '0.010', '-0.010'));
ok('an off-centre process drops Cpk below Cp', off.cpk < off.cp);

console.log('\n7. Thermal error (ISO 1 reference temperature)');
ok('no error at 20 C', near(calc.thermalError(100, 20), 0));
const err = calc.thermalError(16.01, 32);              // the example part, Chennai ambient
ok('16 mm steel at 32 C grows about 2.2 um', near(err * 1000, 2.209, 0.01));
ok('below 20 C it shrinks', calc.thermalError(100, 10) < 0);

console.log('\n8. Decimal places follow the tolerance, never the value');
ok('four decimals kept', decimalsFor({ nominal:'15.5900', upper:'0.0050', lower:'-0.0050' }) === 4);
ok('minimum of three', decimalsFor({ nominal:'15', upper:'0.1', lower:'-0.1' }) === 3);

console.log('\n9. Pasting a CMM table');
const rows = parsePasted(
  'Name\tNominal\t+Tol\t-Tol\tMeasured\n' +
  'Diameter_Circle1\t15.5900\t0.0050\t-0.0050\t15.6100\n' +
  'Length 01,3.1100,0.0050,-0.0050,3.0977,3.0979\n' +
  '\n');
ok('header row skipped', rows.length === 2);
ok('name kept', rows[0].name === 'Diameter_Circle1');
ok('nominal kept', rows[0].nominal === '15.59');
ok('diameter type inferred', rows[0].type === 'diameter');
ok('length type inferred', rows[1].type === 'length');
ok('two pieces captured', parseValues(rows[1].values).length === 2);

console.log('\n10. The audit finds what the example report is missing');
d.state = demoState();
const found = audit(d.state);
const has = t => found.some(f => new RegExp(t, 'i').test(f.title));
ok('blank drawing revision', has('drawing revision is blank'));
ok('equipment not identified', has('equipment not identified'));
ok('shared login', has('shared login'));
ok('no uncertainty stated', has('without a measurement uncertainty'));
ok('blanket tolerance', has('one tolerance applied to every'));
ok('ambiguous Length 01 / Length 1', has('ambiguous names'));
ok('unnamed section headings', has('unnamed section heading'));
ok('no temperature record', has('no temperature record'));
ok('not ballooned', has('not ballooned'));
ok('no approver', has('no independent approval'));
ok('blocking findings are listed first',
   found.length > 1 && found[0].sev === 'block' && found[found.length-1].sev !== 'block');

console.log('\n11. The audit goes quiet once a report is properly built');
d.state = demoState();
const s = d.state;
Object.assign(s.report, {
  drawingRev:'A2', reportNo:'UMS/2026/0914', customer:'JMC Engineering',
  machineName:'CMM', machineModel:'ZEISS Contura 7/10/6', machineSerial:'C-114509',
  calCert:'NABL/CC/26/0881', calDue:'2027-03-31', probeQual:'2026-09-12',
  tempC:'20.4', humidity:'52', tempComp:true, defaultU:'0.0018',
  rule:'Stringent acceptance (ISO 14253-1, guard band = U)',
  inspector:'R. Kannan', approver:'S. Venkatesh', sampleSize:'1'
});
s.company.accred = 'ISO/IEC 17025 accredited, certificate TC-9911';
s.company.logo = 'data:image/png;base64,AAAA';
s.chars.forEach((ch, i) => {
  if (ch.kind === 'group') { ch.name = 'Section ' + (i ? 'B' : 'A'); return; }
  ch.balloon = String(i);
  ch.name = ch.name.replace(/\b0(\d)\b/, '$1') + ' @ ' + ch.group;
  ch.upper = '0.0' + (5 + i);          // break the blanket tolerance
  ch.lower = '-0.0' + (5 + i);
});
s.chars.push({ id:'x', kind:'char', balloon:'99', name:'Roundness, bulge', group:'Section B',
  type:'roundness', assoc:'GN', unit:'mm', nominal:'0', upper:'0.020', lower:'0', U:'0.0018', values:'0.011' });
const after = audit(s);
const blockers = after.filter(f => f.sev === 'block');
ok('nothing blocking remains', blockers.length === 0,
   blockers.map(f => f.title).join(' | '));
ok('uncertainty warning gone', !after.some(f => /without a measurement uncertainty/i.test(f.title)));
ok('balloon warning gone', !after.some(f => /not ballooned/i.test(f.title)));
ok('form-characteristic note gone', !after.some(f => /without any form characteristic/i.test(f.title)));

console.log('\n12. The audit still blocks an expired calibration');
s.report.calDue = '2026-01-01';
ok('out of calibration is blocking',
   audit(s).some(f => f.sev === 'block' && /out of calibration/i.test(f.title)));
s.report.calDue = '2027-03-31';

console.log('\n13. A tolerance the instrument cannot resolve is flagged');
s.report.defaultU = '0.0040';                       // U = 4 um against a 10 um band
s.chars[1].U = '0.0040'; s.chars[1].upper = '0.0050'; s.chars[1].lower = '-0.0050';
ok('4:1 ratio breach reported',
   audit(s).some(f => /uncertainty consumes the tolerance/i.test(f.title)));

console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
