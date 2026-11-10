'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { runPublicResearch } = require('../utils/playground-research');

class Element {
    constructor() { this.children=[]; this.attributes={}; this._text=''; }
    setAttribute(name,value) { this.attributes[name]=value; }
    set textContent(value) { this._text=String(value); this.children=[]; }
    get textContent() { return this._text; }
    set innerHTML(_) { throw new Error('Progress must never insert server text as HTML.'); }
    appendChild(child) { child.parent=this; this.children.push(child); }
    remove() { this.parent.children=this.parent.children.filter(child=>child!==this); }
}
function loaderFixture() {
    const source=fs.readFileSync(require.resolve('../public/js/playground.js'),'utf8');
    const persona=source.slice(source.indexOf('function stageToPersona('),source.indexOf('// Pick an opening cat frame'));
    const loader=source.slice(source.indexOf('function createCatLoader('),source.indexOf('// Sticky-tail auto-scroll'));
    let now=0;
    const timers=new Map();
    const context={document:{createElement:()=>new Element()},performance:{now:()=>now},
        setInterval:fn=>{timers.set(1,fn);return 1;},clearInterval:id=>timers.delete(id)};
    vm.createContext(context);
    vm.runInContext(`${persona}\n${loader}`,context);
    const parent=new Element();
    const widget=context.createCatLoader(parent,{text:'Routing your message...'});
    const find=name=>{
        const walk=node=>node.className===name?node:node.children.map(walk).find(Boolean);
        return walk(parent);
    };
    return { widget,parent,find,timers,advance:ms=>{now+=ms;for(const tick of timers.values())tick();} };
}
async function main() {
    const ui=loaderFixture();
    ui.advance(13000);
    assert.equal(ui.find('cat-loader-text').textContent,'Routing your message...');
    assert.equal(ui.find('cat-loader-note').hidden,false);
    assert(ui.find('cat-loader-note').textContent.includes('Still waiting'));
    ui.widget.setStage('Understanding your request...');
    assert.equal(ui.find('cat-loader-note').hidden,true);
    ui.advance(3000);
    ui.widget.setStage('Understanding your request...');
    assert(ui.find('cat-loader-ticker').textContent.includes('This step 3s'));
    for(const stage of ['Checking the requested data...','Searching public sources...','Reviewing retrieved evidence...','Preparing answer...']) {
        ui.widget.setStage(stage);ui.advance(1000);
    }
    assert.equal(ui.find('cat-loader-trail').children.length,3);
    assert.equal(ui.find('cat-loader-text').attributes['aria-live'],'polite');
    assert.equal(ui.find('cat-loader-ticker').attributes['aria-hidden'],'true');
    ui.widget.setStage('<script>alert(1)</script>');
    assert(ui.find('cat-loader-text').textContent.includes('script'));
    ui.widget.setStage('x'.repeat(200));
    assert.equal(ui.find('cat-loader-text').textContent.length,160);
    ui.widget.stop();ui.widget.stop();
    assert.equal(ui.timers.size,0);
    assert.equal(ui.parent.children.length,0);
    ui.widget.setStage('Late event');
    assert.equal(ui.parent.children.length,0);

    const events=[];
    let selections=0, searches=0;
    const result=await runPublicResearch({
        query:'fixture topic', reader:{attempts:0,admitSources(){}},
        onProgress:event=>events.push(event.stage),
        select:async()=>{
            assert.match(events.at(-1),selections===0?/whether public sources/:/Reviewing retrieved evidence/);
            return {toolCalls:selections++===0?[{id:'test',function:{name:'public_search',arguments:'{"query":"fixture topic"}'}}]:[]};
        },
        search:async()=>{
            searches++;
            assert.equal(events.at(-1),'Searching public sources...');
            return {result:'Fixture source result'};
        }
    });
    assert.equal(searches,1);assert.equal(result.results.length,1);
    assert.deepEqual(events,[
        'Checking whether public sources are needed...','Searching public sources...','Reviewing retrieved evidence...'
    ]);
    const noLookup=[];
    await runPublicResearch({query:'2+2',reader:{attempts:0},onProgress:event=>noLookup.push(event.stage),
        select:async()=>({toolCalls:[]}),search:async()=>{throw new Error('Invented search');}});
    assert.deepEqual(noLookup,['Checking whether public sources are needed...']);

    const pipeline=fs.readFileSync(require.resolve('../utils/pipeline-orchestrator'),'utf8');
    const method=pipeline.slice(pipeline.indexOf('  async stepPreflight('),pipeline.indexOf('  async stepContextBuild('));
    const stages=[];
    const Fixture=vm.runInNewContext(`(class {${method}})`,{
        PIPELINE_STEPS:{PREFLIGHT:'preflight'},
        preflightRouter:async()=>{
            assert.equal(stages.at(-1),'Checking the requested data...');
            throw new Error('fixture stops before any provider call');
        }
    });
    await assert.rejects(()=>new Fixture().stepPreflight({transition(){}},{
        query:'fixture',onStageChange:event=>stages.push(event.stage)
    }),/fixture stops/);
    const bridge=pipeline.indexOf('state.digest = await bridgeQuery(');
    assert(pipeline.lastIndexOf("stage: 'Understanding your request...'",bridge)>pipeline.indexOf('state.transition(PIPELINE_STEPS.DIGEST)'));
    console.log('Playground progress passed: honest stage ordering, no invented search, elapsed/slow-step UX, bounded history, safe text, accessible announcements and timer teardown. No live inference.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
