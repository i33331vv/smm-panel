// Offline regression tests with mocked Firestore / network. No live payments.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const routes={},uses=[],store=new Map();let counter=0,tail=Promise.resolve(),fetches=0;
const clone=x=>x==null?x:structuredClone(x);
function snapshot(ref){const v=store.get(ref.key);return {exists:v!==undefined,id:ref.id,ref,data:()=>clone(v)}}
function doc(c,id='id'+(++counter)){return {key:c+'/'+id,id,get:async function(){return snapshot(this)},set:async function(v){store.set(this.key,clone(v))},update:async function(v){assert(store.has(this.key));store.set(this.key,{...store.get(this.key),...clone(v)})},delete:async function(){store.delete(this.key)}}}
function collection(c){function query(filters=[],limit=Infinity,offset=0){return {orderBy:()=>query(filters,limit,offset),offset:n=>query(filters,limit,n),where:(k,op,v)=>query([...filters,[k,op,v]],limit),limit:n=>query(filters,n,offset),get:async()=>{const docs=[...store.keys()].filter(k=>k.startsWith(c+'/')).map(k=>snapshot(doc(c,k.slice(c.length+1)))).filter(d=>filters.every(([k,op,v])=>op==='in'?v.includes(d.data()[k]):d.data()[k]===v)).slice(offset,offset+limit);return {docs,empty:docs.length===0,size:docs.length,forEach:fn=>docs.forEach(fn)}}}}return {...query(),doc:id=>doc(c,id),add:async v=>{const r=doc(c);await r.set(v);return r},count:()=>({get:async()=>({data:()=>({count:0})})})}}
const db={collection,runTransaction:fn=>{const result=tail.then(async()=>{const writes=[];const tx={get:r=>{assert.equal(writes.length,0,'Firestore reads must precede writes');return r.get()},set:(r,v)=>writes.push(()=>r.set(v)),create:(r,v)=>writes.push(()=>{assert(!store.has(r.key));return r.set(v)}),update:(r,v)=>writes.push(()=>r.update(v))};const out=await fn(tx);for(const w of writes)await w();return out});tail=result.catch(()=>{});return result}};
const app={use:(...v)=>uses.push(v),get:(p,...f)=>routes['GET '+p]=f,post:(p,...f)=>routes['POST '+p]=f,disable:()=>{},set:()=>{}};
const noop=(req,res,next)=>next();
const express=Object.assign(()=>app,{json:()=>noop,urlencoded:()=>noop,static:(p)=>{assert(p.endsWith('/public'));return noop}});
const multer=Object.assign(()=>({single:()=>noop}),{memoryStorage:()=>({}),MulterError:class extends Error{}});
const fakeRequire=n=>({'express':express,'multer':multer,'axios':{},'sharp':()=>({rotate(){return this},resize(){return this},jpeg(){return this},toBuffer:async()=>Buffer.from('test-image')}),'bcryptjs':{hash:async()=> 'hashed',compare:async(p,h)=>p==='correct-password'},'firebase-admin/app':{initializeApp:()=>{},cert:x=>x},'firebase-admin/firestore':{getFirestore:()=>db,Timestamp:{fromMillis:n=>({millis:n}),now:()=>({millis:Date.now()})}}}[n]||require(n));
const context=vm.createContext({require:fakeRequire,module:{exports:{}},__dirname:__dirname,process:{env:{NODE_ENV:'test',APP_ORIGIN:'http://localhost:3000',FIREBASE_SERVICE_ACCOUNT_JSON:'{}',ENABLE_BACKGROUND_JOBS:'false',DEPOSIT_BOT_TOKEN:'dep',ORDERS_BOT_TOKEN:'ord',ADMIN_CHAT_ID:'123',ADMIN_TELEGRAM_USER_ID:'456'}},console,Buffer,URL,Date,setInterval:()=>({unref:()=>{}}),AbortSignal,fetch:async()=>{fetches++;return {json:async()=>({ok:true,result:{message_id:1}})}}});
vm.runInContext(fs.readFileSync(__dirname+'/server.js','utf8'),context);
function evaluate(code){return vm.runInContext(code,context)}
function response(){return {code:200,body:null,status(n){this.code=n;return this},json(v){this.body=v;return this},cookie(){},clearCookie(){},set(){return this}}}
async function call(name,req){const res=response();for(const fn of routes[name]){let err;await fn(req,res,e=>{err=e});if(err)throw err;if(res.body)break}return res}
(async()=>{
assert.equal(evaluate("extractInstagramUsername('https://instagram.com.attacker.test/test')"),null);
assert.equal(evaluate("extractInstagramUsername('https://instagram.com/test/extra')"),null);
assert.equal(evaluate("extractInstagramUsername('https://www.instagram.com/test_user/')"),'test_user');
assert.throws(()=>evaluate("serviceInput({category:'x',name:'y',price:-1})"));
assert.equal(evaluate("serviceInput({category:'x',name:'y',price:0.5,maxQty:''}).maxQty"),null);
let authError;await evaluate('requireAuth')({headers:{}},response(),e=>authError=e);assert.equal(authError.status,401);
let adminError;evaluate('requireAdmin')({user:{role:'user'}},response(),e=>adminError=e);assert.equal(adminError.status,403);
const csrf=uses.find(x=>x[0]==='/api' && String(x[1]).includes('sec-fetch-site'))[1];let csrfError;csrf({method:'POST',headers:{origin:'https://attacker.test'},body:{}},response(),e=>csrfError=e);assert.equal(csrfError.status,403);
const wayl=uses.find(x=>x[0]==='/api/wayl')[1],wr=response();wayl({},wr);assert.equal(wr.code,410);
await assert.rejects(()=>call('GET /api/user/:email',{params:{email:'other@test.com'},user:{email:'self@test.com'}}),e=>e.status===403);
const profile=await call('GET /api/user/:email',{params:{email:'self@test.com'},user:{email:'self@test.com',username:'self',password:'secret',balance:1}});assert(!('password' in profile.body.user));
await evaluate('consumeLimit')('test',1,60000);await assert.rejects(()=>evaluate('consumeLimit')('test',1,60000),e=>e.status===429);
store.set('users/u1',{username:'owner',email:'owner@test.com',balance:5});
store.set('deposit_requests/d1',{user_id:'u1',status:'معلق',amount:2});
const cb={from:{id:456},message:{chat:{id:123},message_id:1},data:'dep_accept_d1',id:'callback'};
await evaluate('handleTelegramCallback')('dep',{...cb,from:{id:999}});assert.equal(fetches,0);assert.equal(store.get('users/u1').balance,5);
await Promise.all([evaluate('handleTelegramCallback')('dep',cb),evaluate('handleTelegramCallback')('dep',cb)]);assert.equal(store.get('users/u1').balance,7);
store.set('orders/o1',{user_id:'u1',username:'owner',status:'قيد التنفيذ',charge:3,quantity:100,link:'https://instagram.com/x',service:'x'});
const cancel={...cb,data:'ord_cancel_o1'};
await Promise.all([evaluate('handleTelegramCallback')('ord',cancel),evaluate('handleTelegramCallback')('ord',cancel)]);assert.equal(store.get('users/u1').balance,10);assert.equal(store.get('orders/o1').status,'ملغي');
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_progress_o1'});assert.equal(store.get('orders/o1').status,'ملغي');
store.set('orders/o2',{user_id:'u1',username:'owner',status:'قيد التنفيذ',charge:1,quantity:100,current_count:20,target_count:120,link:'https://instagram.com/x',service:'x'});
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_complete_o2'});assert.equal(store.get('orders/o2').current_count,20);assert.equal(store.get('orders/o2').status,'مكتمل');
assert(uses.some(x=>x[0]==='/api/admin' && x.length===3));
assert(uses.some(x=>x[0]==='/api/asiacell' && x.length===3));
const invalidStart=await call('POST /api/asiacell/initiate-transfer',{body:{phone:'bad',amountUSD:1},user:{id:'u1',email:'owner@test.com'}});assert.equal(invalidStart.code,400);
const invalidConfirm=await call('POST /api/asiacell/confirm-transfer',{body:{phone:'bad',transferOtp:'123456'},user:{id:'u1',email:'owner@test.com'}});assert.equal(invalidConfirm.code,400);
context.asiacellCalls=[];
evaluate("callAsiacellAPI = async (...args) => { asiacellCalls.push(args); return {ok:true,isWafBlocked:false,data:{success:true,PID:'p1'},cookies:''}; };");
store.set('asiacell_sessions/u1_07712345678',{ownerId:'u1',step:'SELECT_AMOUNT',updatedAt:Date.now(),accessToken:'test'});
const start=await call('POST /api/asiacell/initiate-transfer',{body:{phone:'07712345678',amountUSD:1,receiverMsisdn:'07700000000'},user:{id:'u1',email:'owner@test.com'}});assert.equal(start.body.success,true);
assert.equal(context.asiacellCalls[0][2].receiverMsisdn,'07738889080');
const confirmReq={body:{phone:'07712345678',transferOtp:'123456',email:'attacker@test.com',amount:999},user:{id:'u1',email:'owner@test.com'}};
const before=store.get('users/u1').balance;
const confirm=await call('POST /api/asiacell/confirm-transfer',confirmReq);assert.equal(confirm.body.success,true);assert.equal(confirm.body.newBalance,before+1);
const again=await call('POST /api/asiacell/confirm-transfer',confirmReq);assert.equal(again.body.success,false);assert.equal(store.get('users/u1').balance,before+1);
const sessionResponse=response();let savedCookie;
sessionResponse.cookie=(name,value,options)=>{savedCookie={name,value,options};};
await evaluate('issueSession')({headers:{}},sessionResponse,'u1');
assert.equal(savedCookie.options.maxAge,365*24*60*60*1000);
assert.equal(savedCookie.options.httpOnly,true);
const sessionKey='web_sessions/'+crypto.createHash('sha256').update(savedCookie.value).digest('hex');
assert.equal(store.get(sessionKey).expiresAt,undefined);
const authenticated={headers:{cookie:savedCookie.name+'='+savedCookie.value}};
let validationError;await evaluate('requireAuth')(authenticated,sessionResponse,e=>validationError=e);
assert.equal(validationError,undefined);assert.equal(authenticated.user.id,'u1');
await call('POST /api/logout',authenticated);assert.equal(store.has(sessionKey),false);
let revokedError;await evaluate('requireAuth')(authenticated,response(),e=>revokedError=e);assert.equal(revokedError.status,401);
// Financial extension tests: serialized competing transactions and read-before-write checks.
const {rewardFor,toIQD}=require('./rewards.cjs');
assert.equal(toIQD(10),10000);
assert.equal(rewardFor(9),0);assert.equal(rewardFor(10),500);assert.equal(rewardFor(20),1000);assert.equal(rewardFor(25),1000);
store.set('users/ref',{username:'referrer',email:'ref@test.com',balance:0,profitIQD:0,spent:0});
store.set('users/payer',{username:'payer',email:'payer@test.com',balance:0,spent:0,profitIQD:0});
function user(id){return {id,ref:doc('users',id),...store.get('users/'+id)}}
async function api(route,id,body={},extra={}){return call(route,{body,user:user(id),...extra})}
const active=await api('POST /api/profits/activate','ref');
const code=active.body.code;assert.match(code,/^[A-F0-9]{12}$/);
assert.equal((await api('POST /api/profits/activate','ref')).body.code,code);
await api('POST /api/profits/activate','payer');
await assert.rejects(()=>api('POST /api/profits/support','ref',{code}));
await api('POST /api/profits/support','payer',{code});
await assert.rejects(()=>api('POST /api/profits/support','payer',{code}));
store.set('deposit_requests/reward20',{user_id:'payer',status:'معلق',amount:20});
await Promise.all([evaluate('handleTelegramCallback')('dep',{...cb,data:'dep_accept_reward20'}),evaluate('handleTelegramCallback')('dep',{...cb,data:'dep_accept_reward20'})]);
assert.equal(store.get('users/payer').balance,20);assert.equal(store.get('users/payer').profitIQD,0);assert.equal(store.get('users/ref').profitIQD,1000);
assert.equal(store.get('referral_rewards/reward20').amountIQD,1000);
store.set('deposit_requests/rejected',{user_id:'payer',status:'معلق',amount:100});
await evaluate('handleTelegramCallback')('dep',{...cb,data:'dep_reject_rejected'});
await evaluate('handleTelegramCallback')('dep',{...cb,data:'dep_accept_rejected'});
assert.equal(store.get('users/ref').profitIQD,1000);
const tooHigh=await api('POST /api/asiacell/initiate-transfer','payer',{phone:'07712345678',amountUSD:20});assert.equal(tooHigh.code,400);
// Confirmed Asiacell deposit pays referral exactly once.
store.set('asiacell_sessions/payer_07712345678',{ownerId:'payer',step:'SELECT_AMOUNT',updatedAt:Date.now(),accessToken:'test'});
await api('POST /api/asiacell/initiate-transfer','payer',{phone:'07712345678',amountUSD:10});
await api('POST /api/asiacell/confirm-transfer','payer',{phone:'07712345678',transferOtp:'123456'});
assert.equal(store.get('users/ref').profitIQD,1500);
await api('POST /api/asiacell/confirm-transfer','payer',{phone:'07712345678',transferOtp:'123456'});
assert.equal(store.get('users/ref').profitIQD,1500);
// Historical spent, cancellation and repeat cancellation.
store.set('users/history',{username:'history',balance:1});
store.set('orders/h1',{user_id:'history',status:'مكتمل',charge:2});
store.set('orders/h2',{user_id:'history',status:'ملغي',charge:4});
store.set('orders/h3',{user_id:'history',status:'قيد التنفيذ',charge:3});
await evaluate('rewards.initialiseSpent')(doc('users','history'));
assert.equal(store.get('users/history').spent,5);
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_cancel_h3'});
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_cancel_h3'});
assert.equal(store.get('users/history').spent,2);
// Service orders increment spent, and cancellation reverses the exact charge.
store.set('users/buyer',{username:'buyer',email:'buyer@test.com',balance:20,spent:0});
store.set('services/svc',{category:'Instagram',name:'Followers',price:10,baseQuantity:1000,minQty:100,maxQty:null,description:''});
evaluate("checkInstagramProfile = async () => ({valid:true,username:'buyer',followers:10,isPrivate:false});");
const placed=await api('POST /api/order','buyer',{serviceId:'svc',link:'https://instagram.com/buyer',quantity:1000},{ip:'test'});
assert.equal(placed.body.success,true);assert.equal(store.get('users/buyer').balance,10);assert.equal(store.get('users/buyer').spent,10);
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_cancel_'+placed.body.orderId});
assert.equal(store.get('users/buyer').balance,20);assert.equal(store.get('users/buyer').spent,0);
// Social link validation and order creation: never use followers for media orders.
assert(uses.some(x=>x[0]==='/api/links' && x.length===3));
const parse=evaluate('parseServiceLink');
const igFollowers={category:'انستقرام',name:'متابعين'};
const igLikes={category:'انستقرام',name:'لايكات ريلز وبوست'};
const ttFollowers={category:'تيك توك',name:'متابعين'};
const ttViews={category:'تيك توك',name:'مشاهدات'};
for(const link of ['https://instagram.com/p/ABC_12/?igsh=abc','https://www.instagram.com/reel/ABC-12/','https://instagram.com/share/reel/ABC/']) {
 assert.equal(parse(link,igLikes).kind,'media');assert.equal(parse(link,igLikes).monitorFollowers,false);
 assert.throws(()=>parse(link,igFollowers));
}
assert.equal(parse('https://tiktok.com/@test',ttFollowers).kind,'profile');
assert.equal(parse('@test',ttFollowers).platform,'tiktok');
for(const link of ['https://www.tiktok.com/@test/video/123456','https://www.tiktok.com/@test/photo/123456','https://vm.tiktok.com/ABC123/','https://vt.tiktok.com/ABC123/','https://www.tiktok.com/t/ABC123/']) assert.equal(parse(link,ttViews).platform,'tiktok');
for(const link of ['https://instagram.com.evil.test/p/ABC/','https://instagram.com@evil.test/p/ABC/','javascript:alert(1)','https://127.0.0.1/a','https://www.tiktok.com/not-a-post','https://instagram.com/p/','https://www.instagram.com:444/p/ABC/','https://www.instagram.com/p/ABC/extra']) assert.throws(()=>parse(link,{}));
assert.throws(()=>parse('https://tiktok.com/@test/video/123',igLikes));
assert.throws(()=>parse('https://instagram.com/buyer',igLikes));
assert.throws(()=>parse('https://vm.tiktok.com/ABC/',ttFollowers));
context.profileCalls=0;
evaluate("checkInstagramProfile = async () => { profileCalls++; return {valid:true,username:'buyer',followers:10,isPrivate:false}; };");
const cases=[
 [igLikes,'https://instagram.com/p/ABC/?igsh=keep'],
 [igLikes,'https://instagram.com/reel/ABC/'],
 [ttFollowers,'https://www.tiktok.com/@buyer'],
 [ttViews,'https://www.tiktok.com/@buyer/video/12345'],
 [ttViews,'https://www.tiktok.com/@buyer/photo/12345'],
 [ttViews,'https://vm.tiktok.com/ABC123/']
];
for(let i=0;i<cases.length;i++) {
 const [service,link]=cases[i],id='social'+i,sid='socialsvc'+i;
 store.set('users/'+id,{username:id,email:id+'@test.com',balance:20,spent:0});
 store.set('services/'+sid,{...service,price:1,baseQuantity:1000,minQty:100,maxQty:null});
 const preview=await api('POST /api/links/check',id,{serviceId:sid,link});
 assert.equal(preview.body.success,true);assert.equal(preview.body.followers,null);
 const created=await api('POST /api/order',id,{serviceId:sid,link,quantity:1000},{ip:'test'});
 assert.equal(created.body.success,true,JSON.stringify(created.body));
 const order=store.get('orders/'+created.body.orderId);
 assert.equal(order.link,link);assert.equal(order.ig_username,null);assert.equal(order.start_count,null);assert.equal(order.target_count,null);
 assert.equal(store.get('users/'+id).balance,19);assert.equal(store.get('users/'+id).spent,1);
 await evaluate('syncSingleOrderCount')(snapshot(doc('orders',created.body.orderId)));
}
assert.equal(context.profileCalls,0,'No Instagram scrape or follower monitoring for media/TikTok');
const invalid=await api('POST /api/order','social0',{serviceId:'socialsvc0',link:'https://instagram.com/buyer',quantity:1000},{ip:'test'});
assert.equal(invalid.code,400);assert.equal(store.get('users/social0').balance,19);
const checked=await api('POST /api/links/check','buyer',{serviceId:'svc',link:'https://instagram.com/buyer'});
assert.equal(checked.body.followers,10);assert.equal(context.profileCalls,1);
evaluate("checkInstagramProfile = async () => ({valid:true,isPrivate:true,followers:10});");
const privateOrder=await api('POST /api/order','buyer',{serviceId:'svc',link:'https://instagram.com/buyer',quantity:1000},{ip:'test'});
assert.equal(privateOrder.code,400);assert.equal(store.get('users/buyer').balance,20);
// Provider outage accepts valid syntax, marks unknown, debits once and never invents a baseline.
evaluate("checkInstagramProfile = async () => ({valid:false,unreachable:true,message:'temporary'});");
store.set('users/unknown',{username:'unknown',email:'unknown@test.com',balance:20,spent:0});
const unknownPreview=await api('POST /api/links/check','unknown',{serviceId:'svc',link:'https://instagram.com/unknown'});
assert.equal(unknownPreview.body.success,true);assert.equal(unknownPreview.body.verificationStatus,'unverified');assert.equal(unknownPreview.body.followers,null);
const unknownOrder=await api('POST /api/order','unknown',{serviceId:'svc',link:'https://instagram.com/unknown',quantity:1000},{ip:'test'});
assert.equal(unknownOrder.body.success,true);
const unknownSaved=store.get('orders/'+unknownOrder.body.orderId);
assert.equal(unknownSaved.verification_status,'unverified');assert.equal(unknownSaved.start_count,null);assert.equal(unknownSaved.target_count,null);assert.equal(unknownSaved.account_private,null);
const unknownBalance=store.get('users/unknown').balance;
assert(unknownBalance<20);
const repeatedUnknown=await api('POST /api/order','unknown',{serviceId:'svc',link:'https://instagram.com/unknown',quantity:1000},{ip:'test'});
assert.equal(repeatedUnknown.code,409);assert.equal(store.get('users/unknown').balance,unknownBalance);
assert(evaluate('buildOrderTelegramMessage')(unknownOrder.body.orderId,unknownSaved).includes('لم يتم التحقق'));
evaluate("checkInstagramProfile = async () => { throw new Error('Must not monitor a missing baseline'); };");
await evaluate('syncSingleOrderCount')(snapshot(doc('orders',unknownOrder.body.orderId)));
assert.equal(store.get('orders/'+unknownOrder.body.orderId).status,'قيد المعالجة');
console.log('PASS: unverified preview/order accepted, real debit once, duplicate blocked, unknown privacy/count, Telegram warning, no automatic completion without baseline.');
console.log('PASS: Instagram media, TikTok profiles/video/photo/short links, host/type rejection, preview/order agreement, real debit, no wrong follower monitoring.');
// Same user + service + target: reject active duplicates atomically, including aliases.
store.set('users/double',{username:'double',email:'double@test.com',balance:100,spent:0});
store.set('services/ttf',{category:'تيك توك',name:'متابعين',price:1,baseQuantity:1000,minQty:1,maxQty:null});
const dupeRequest={serviceId:'ttf',link:'https://www.tiktok.com/@Same_User?tracking=1',quantity:1000};
const results=await Promise.all([api('POST /api/order','double',dupeRequest),api('POST /api/order','double',{...dupeRequest,link:'http://tiktok.com/@same_user/'})]);
assert.equal(results.filter(r=>r.body.success).length,1);assert.equal(results.filter(r=>r.code===409).length,1);
assert.equal(store.get('users/double').balance,99);assert.equal(store.get('users/double').spent,1);
const firstId=results.find(r=>r.body.success).body.orderId;
store.get('orders/'+firstId).status='قيد التنفيذ';
assert.equal((await api('POST /api/order','double',{...dupeRequest,quantity:500})).code,409);
assert.equal((await api('POST /api/order','double',{...dupeRequest,link:'https://tiktok.com/@different'})).body.success,true);
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_complete_'+firstId});
const afterComplete=await api('POST /api/order','double',dupeRequest);assert.equal(afterComplete.body.success,true);
await evaluate('handleTelegramCallback')('ord',{...cb,data:'ord_cancel_'+afterComplete.body.orderId});
assert.equal((await api('POST /api/order','double',dupeRequest)).body.success,true);
assert.equal(store.get('users/double').balance,97);assert.equal(store.get('users/double').spent,3);
// Old rows have no target_key; the same matching rule applies without a migration.
store.set('users/legacydup',{username:'legacydup',email:'legacydup@test.com',balance:50,spent:0});
store.set('orders/legacydup',{username:'legacydup',service:'[تيك توك] متابعين',link:'https://www.tiktok.com/@Same_User/',status:'قيد المعالجة'});
assert.equal((await api('POST /api/order','legacydup',dupeRequest)).code,409);assert.equal(store.get('users/legacydup').balance,50);
assert.equal(evaluate("orderTargetKey('https://instagram.com/Some_User/?igsh=1', {category:'Instagram',name:'Followers'})"),evaluate("orderTargetKey('http://www.instagram.com/some_user', {category:'Instagram',name:'Followers'})"));
assert.equal(evaluate("orderTargetKey('https://instagram.com/reel/ABC_1/?igsh=1', {category:'Instagram',name:'Likes'})"),evaluate("orderTargetKey('https://www.instagram.com/p/ABC_1/', {category:'Instagram',name:'Likes'})"));
assert.notEqual(evaluate("orderTargetKey('https://instagram.com/p/ABC_1/', {})"),evaluate("orderTargetKey('https://instagram.com/p/abc_1/', {})"));
console.log('PASS: concurrent duplicate rejected without debit; aliases/case/query normalized; different target allowed; completion/cancellation reopen; old records supported.');
// Conversion double submission cannot double credit, and cannot reward another user.
const conversion={amountIQD:1000,requestId:crypto.randomUUID()};
await Promise.all([api('POST /api/profits/convert','ref',conversion),api('POST /api/profits/convert','ref',conversion)]);
assert.equal(store.get('users/ref').profitIQD,500);assert.equal(store.get('users/ref').balance,1);
await assert.rejects(()=>api('POST /api/profits/convert','ref',{amountIQD:1000,requestId:crypto.randomUUID()}));
// Withdraw immediate debit, idempotency, cancellation refund once, and completed state.
store.get('users/ref').profitIQD=25000;
const withdrawal={amountIQD:10000,card:'7111053109',requestId:crypto.randomUUID()};
const file={buffer:Buffer.from('test-image')};
const w=await api('POST /api/profits/withdraw','ref',withdrawal,{file});
assert.equal(store.get('users/ref').profitIQD,15000);
await api('POST /api/profits/withdraw','ref',withdrawal,{file});assert.equal(store.get('users/ref').profitIQD,15000);
await assert.rejects(()=>api('POST /api/profits/withdraw','ref',{...withdrawal,requestId:crypto.randomUUID()},{file}));
assert(Buffer.byteLength('wc_'+w.body.id)<=64);
const wc={...cb,data:'wc_'+w.body.id};
await evaluate('handleTelegramCallback')('dep',{...wc,from:{id:0}});assert.equal(store.get('users/ref').profitIQD,15000);
await Promise.all([evaluate('handleTelegramCallback')('dep',wc),evaluate('handleTelegramCallback')('dep',wc)]);
assert.equal(store.get('users/ref').profitIQD,25000);
await evaluate('handleTelegramCallback')('dep',{...wc,data:'wp_'+w.body.id});assert.equal(store.get('users/ref').profitIQD,25000);
const w2=await api('POST /api/profits/withdraw','ref',{...withdrawal,requestId:crypto.randomUUID()},{file});
await evaluate('handleTelegramCallback')('dep',{...cb,data:'wp_'+w2.body.id});
await evaluate('handleTelegramCallback')('dep',{...cb,data:'wc_'+w2.body.id});
assert.equal(store.get('users/ref').profitIQD,15000);
assert.equal(store.get('profit_withdrawals/'+w2.body.id).status,'تم سحب الأرباح');
await assert.rejects(()=>api('POST /api/profits/withdraw','ref',{...withdrawal,amountIQD:9999,requestId:crypto.randomUUID()},{file}));
// Admin adjustments are journaled and replay protected. Ban blocks existing sessions.
store.set('users/admin',{username:'admin',email:'admin@test.com',role:'admin',balance:0,spent:0});
const adjustment={action:'add',amountIQD:5000,requestId:crypto.randomUUID()};
await Promise.all([api('POST /api/admin/users/:id/action','admin',adjustment,{params:{id:'payer'}}),api('POST /api/admin/users/:id/action','admin',adjustment,{params:{id:'payer'}})]);
assert.equal(store.get('users/payer').balance,35);assert.equal(store.get('users/ref').profitIQD,15000);
await assert.rejects(()=>api('POST /api/admin/users/:id/action','payer',adjustment,{params:{id:'ref'}}));
await assert.rejects(()=>api('POST /api/admin/users/:id/action','admin',{action:'subtract',amountIQD:999999,requestId:crypto.randomUUID()},{params:{id:'payer'}}));
await api('POST /api/admin/users/:id/action','admin',{action:'ban',requestId:crypto.randomUUID()},{params:{id:'payer'}});
assert.equal(store.get('users/payer').disabled,true);
await evaluate('issueSession')({headers:{}},sessionResponse,'payer');
let banned;await evaluate('requireAuth')({headers:{cookie:savedCookie.name+'='+savedCookie.value}},response(),e=>banned=e);assert.equal(banned.status,403);assert.equal(banned.code,'ACCOUNT_BANNED');
const banCookie=savedCookie.name+'='+savedCookie.value;
let gateError;await evaluate('rejectBannedSession')({headers:{cookie:banCookie}},response(),e=>gateError=e);
assert.equal(gateError.code,'ACCOUNT_BANNED');
assert(uses.some(x=>x[0]==='/api/register' && x[1]===evaluate('rejectBannedSession')));
assert(uses.some(x=>x[0]==='/api/login' && x[1]===evaluate('rejectBannedSession')));
let guestError;await evaluate('rejectBannedSession')({headers:{}},response(),e=>guestError=e);assert.equal(guestError,undefined);
store.set('users/bannedlogin',{username:'bannedlogin',email:'bannedlogin@test.com',password:'hashed',disabled:true});
await assert.rejects(()=>call('POST /api/login',{body:{email:'bannedlogin@test.com',password:'wrong'},headers:{}}),e=>e.status===401 && !e.code);
let bannedLoginCookie;
const lr=response();lr.cookie=(name,value)=>bannedLoginCookie=name+'='+value;
const loginHandler=routes['POST /api/login'].at(-1);
await assert.rejects(()=>loginHandler({body:{email:'bannedlogin@test.com',password:'correct-password'},headers:{}},lr),e=>e.code==='ACCOUNT_BANNED');
assert(bannedLoginCookie);
let renewedBan;await evaluate('requireAuth')({headers:{cookie:bannedLoginCookie}},response(),e=>renewedBan=e);assert.equal(renewedBan.code,'ACCOUNT_BANNED');
const errorHandler=uses.find(u=>u.length===1 && u[0].length===4)[0];
const er=response();errorHandler(banned,{},er,()=>{});assert.equal(er.code,403);assert.equal(er.body.code,'ACCOUNT_BANNED');
await api('POST /api/admin/users/:id/action','admin',{action:'unban',requestId:crypto.randomUUID()},{params:{id:'payer'}});
assert.equal(store.get('users/payer').disabled,false);
let unbanError;const restoredReq={headers:{cookie:banCookie}};
await evaluate('requireAuth')(restoredReq,response(),e=>unbanError=e);assert.equal(unbanError,undefined);assert.equal(restoredReq.user.id,'payer');
// Exercise real frontend response handling with minimal DOM stubs.
const nodes=new Map();const classes=new Set();let prompts=0,dashboards=0;
function node(id){if(!nodes.has(id))nodes.set(id,{hidden:true,classList:{add(){},remove(){}},focus(){},textContent:''});return nodes.get(id)}
let reply={status:403,ok:false,clone(){return {json:async()=>({code:'ACCOUNT_BANNED'})}}};
const browser=vm.createContext({URL,window:{location:{origin:'https://mtnajm.com'}},document:{body:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}},getElementById:node,querySelectorAll:()=>[]},fetch:async()=>reply,currentUser:{username:'payer'},hideAllSections:()=>{},updateAdminVisibility:()=>{},toggleView:()=>{},openModal:()=>prompts++,showDashboard:()=>dashboards++});
const js=fs.readFileSync(__dirname+'/public/app.csp.js','utf8');
vm.runInContext(js.slice(js.indexOf('        let accountBanned'),js.indexOf('        function openModal')),browser);
await vm.runInContext("apiFetch('/api/me')",browser);
assert(classes.has('account-banned'));assert.equal(node('banned-page').hidden,false);assert.equal(prompts,0);
await vm.runInContext('restoreSession(true)',browser);assert.equal(prompts,0);
reply={status:200,ok:true,json:async()=>({success:true,user:{username:'payer',email:'payer@test.com',balance:35}})};
await vm.runInContext('restoreSession()',browser);assert(!classes.has('account-banned'));assert.equal(node('banned-page').hidden,true);assert.equal(dashboards,1);
reply={status:403,ok:false,clone(){return {json:async()=>({message:'غير مسموح'})}}};
await vm.runInContext("apiFetch('/api/me')",browser);assert(!classes.has('account-banned'));
console.log('PASS: ban screen for authenticated ban and valid banned login; no login prompt, wrong-password privacy, registration gate, unban recovery, ordinary 403 unaffected.');
const list=await api('GET /api/admin/users','admin',{}, {query:{q:'payer@test.com',page:0}});
assert.equal(list.body.users.length,1);assert.equal(list.body.users[0].balanceIQD,35000);assert(!('password' in list.body.users[0]));
assert(uses.some(u=>u[0]==='/api/profits'));
// Registration boundary check: 7 rejected, 8 letters/digits and longer accepted.
const registerHandler=routes['POST /api/register'].at(-1);
await assert.rejects(()=>registerHandler({body:{username:'shortpass',email:'shortpass@test.com',password:'1234567'},headers:{}},response()),e=>e.status===400);
for(const [name,password] of [['eightdigits','12345678'],['eightletters','abcdefgh'],['longpassword','abcdefgh123456789']]) {
 const r=response();await registerHandler({body:{username:name,email:name+'@test.com',password},headers:{}},r);assert.equal(r.body.success,true);
}
console.log('PASS: password lengths 7 rejected; 8 digits, 8 letters, and longer accepted.');
// Flexible deposit units: raw user input is normalized on the SERVER.
const normalizeDeposit=evaluate('depositInputIQD');
for(const [raw,expected] of [['1',1000],['10',10000],['10000',10000],['100',100000],['100000',100000],['500',500000],['1000',1000],['1.5',1500]])assert.equal(normalizeDeposit(raw),expected);
for(const raw of ['',0,'0.5',-1,'NaN','1e4','abc','1000.5','100000001'])assert.throws(()=>normalizeDeposit(raw));
for(const [i,gateway,raw,expected] of [[0,'Binance','10',10000],[1,'ZainCash','10000',10000],[2,'Mastercard','1',1000],[3,'Mastercard','500',500000]]) {
 const uid='flex'+i;store.set('users/'+uid,{username:uid,email:uid+'@test.com',balance:0,spent:0});
 // Mock sharp produces identical bytes for all images; reset its fixture hash only.
 for(const key of [...store.keys()])if(key.startsWith('receipt_hashes/'))store.delete(key);
 const result=await api('POST /api/deposit/submit',uid,{gateway,amountInput:raw,amount:99999},{file:{buffer:Buffer.from('receipt'+i)}});
 assert.equal(result.body.success,true);assert.equal(store.get('users/'+uid).balance,0);
 const pendingId=store.get('deposit_locks/'+uid).id;
 assert.equal(store.get('deposit_requests/'+pendingId).amount,expected/1000);
 await evaluate('handleTelegramCallback')('dep',{...cb,data:'dep_accept_'+pendingId});
 await evaluate('handleTelegramCallback')('dep',{...cb,data:'dep_accept_'+pendingId});
 assert.equal(store.get('users/'+uid).balance*1000,expected);
}
// Browser confirmation uses the same normalization, and sends raw input only.
const clientJS=fs.readFileSync(__dirname+'/public/app.csp.js','utf8');
const browserUnits=vm.createContext({});
vm.runInContext(clientJS.slice(clientJS.indexOf('function depositInputIQD'),clientJS.indexOf('        let fetchedServices')),browserUnits);
for(const raw of ['1','10','10000','500','1000','1.5'])assert.equal(vm.runInContext('depositInputIQD',browserUnits)(raw),normalizeDeposit(raw));
assert(clientJS.includes("'amountInput',\n                enteredAmount"));
assert(clientJS.includes('Number(serv.price || 0) * 1000;'));
const featuresOriginal=fs.readFileSync(__dirname+'/public/features.js','utf8');
assert(featuresOriginal.includes('مبلغ السحب بالدينار'));assert(featuresOriginal.includes('min="10000"'));
console.log('PASS: 10 and 10000 both credit 10000 IQD once after approval; 1=>1000; 500=>500000; sub-minimum rejected; other fields restored to full IQD.');
console.log('PASS: security regression, currency conversion, referral ownership and once-only rewards, Asiacell limit, historic spent/refund, conversion idempotency, withdrawal debit/approve/cancel/replay/authorization, admin balance changes and ban.');
})().catch(e=>{console.error(e);process.exitCode=1});
