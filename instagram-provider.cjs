'use strict';
const assert = require('node:assert/strict');
const {createInstagramProvider} = require('./instagram-provider.cjs');
const publicUser = {username:'buyer',is_private:false,edge_followed_by:{count:100}};
const apifyUser = {username:'buyer',private:false,followersCount:100};
function setup(steps, token='test-token') {
    let clock = 10000;
    const calls = [];
    const request = async (method,url,body,config) => {
        calls.push({method,url,config});
        assert(config.timeout <= 7000);
        assert(config.signal);
        assert(!url.includes('test-token'));
        const step = steps.shift();
        if (step instanceof Error) throw step;
        return {status:200,data:step};
    };
    const check = createInstagramProvider({token,now:()=>clock,logger:{warn(){}},axios:{
        post:(u,b,c)=>request('post',u,b,c),get:(u,c)=>request('get',u,null,c)}});
    return {check,calls,advance:n=>clock+=n};
}
(async()=>{
    let s = setup([[apifyUser]]);
    const [a,b] = await Promise.all([s.check('buyer'),s.check('BUYER')]);
    assert(a.valid && !a.isPrivate);assert.equal(a.followers,100);assert.deepEqual(a,b);assert.equal(s.calls.length,1);
    await s.check('buyer');assert.equal(s.calls.length,1);
    s = setup([new Error('timeout'),{data:{user:publicUser}}]);
    assert.equal((await s.check('buyer')).source,'instagram-web');assert.equal(s.calls.length,2);
    s = setup([[],{},'<script type="application/json">'+JSON.stringify({nested:{user:publicUser}})+'</script>']);
    assert.equal((await s.check('buyer')).source,'instagram-page');assert.equal(s.calls.length,3);
    s = setup([[{...apifyUser,private:true,followersCount:null}]]);
    assert.equal((await s.check('buyer')).isPrivate,true);assert.equal(s.calls.length,1);
    s = setup([[],{},'<html>Login required</html>']);
    const failed=await s.check('buyer');assert.equal(failed.valid,false);assert.equal(failed.unreachable,true);assert.equal(failed.followers,undefined);
    await s.check('buyer');assert.equal(s.calls.length,3);
    s = setup([{data:{user:publicUser}}],'');assert.equal((await s.check('buyer')).source,'instagram-web');assert.equal(s.calls.length,1);
    s = setup([[{...apifyUser,username:'someone_else'}],{data:{user:{username:'buyer',is_private:false}}},'']);
    assert.equal((await s.check('buyer')).unreachable,true);
    const limited = new Error('429');limited.response={status:429,headers:{'retry-after':'300'}};
    s=setup([[],limited]);assert.equal((await s.check('buyer')).unreachable,true);assert.equal(s.calls.length,2,'Do not hammer same Instagram host via page after 429');
    s=setup([[{...apifyUser,followersCount:0}]]);assert.equal((await s.check('buyer')).followers,0);
    assert.equal((await s.check('../evil')).valid,false);
    console.log('PASS: each fallback stage, private stop, unknown result, exact username/privacy/count, zero, no-token direct fallback, concurrency/cache, shared 429 cooldown, bounded timeout settings. Mock network only.');
})().catch(error=>{console.error(error);process.exitCode=1;});
