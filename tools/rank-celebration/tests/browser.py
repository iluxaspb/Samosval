#!/usr/bin/env python3
"""Real Chromium visual/runtime/audio acceptance for isolated rank celebration.
Actual CSS/JS are loaded byte-for-byte; app state is explicitly synthetic.
No Firebase, remote assets, production writes, or balance calculations are used.
Requires Python Playwright plus Chromium; exits nonzero if browser is blocked.
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import struct
import sys
import time
import traceback
from pathlib import Path
from fixture import build_fixture


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path):
    data=path.read_bytes()
    assert data[:8]==b'\x89PNG\r\n\x1a\n', f'Invalid screenshot: {path}'
    assert len(data)>1500, f'Unexpectedly empty screenshot: {path}'
    return struct.unpack('>II',data[16:24])


def cleanup_assert(snapshot):
    for key in ['notice','noticeConnected','timer','canvas','frame','lifecycle','bus']:
        assert not snapshot[key], f'Cleanup left {key}: {snapshot}'
    for key in ['sources','nodes','noticeCount','canvasCount']:
        assert snapshot[key]==0, f'Cleanup left {key}: {snapshot}'
    assert snapshot['errors']==[], snapshot['errors']
    assert snapshot['requests']==[], snapshot['requests']


def centered(snapshot):
    box=snapshot['rect']; viewport=snapshot['viewport']
    assert snapshot['noticeCount']==1, snapshot
    assert box and box['width']>180 and box['height']>100, snapshot
    assert abs(box['x']+box['width']/2-viewport['width']/2)<=2, snapshot
    assert abs(box['y']+box['height']/2-viewport['height']/2)<=2, snapshot
    assert box['x']>=7 and box['x']+box['width']<=viewport['width']-7, snapshot
    assert box['y']>=0 and box['y']+box['height']<=viewport['height'], snapshot
    assert snapshot['pointerEvents']=='none', 'Celebration must not block work beneath it'


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source-root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parent/'results')
    parser.add_argument('--chromium',default=os.environ.get('AUDIT_BROWSER'))
    parser.add_argument('--no-video',action='store_true',help='Diagnostic only; final acceptance must include video')
    args=parser.parse_args(); args.output.mkdir(parents=True,exist_ok=True)
    html=build_fixture(args.source_root)
    preview=args.output/'rank-preview.html';preview.write_text(html)
    report={'scope':'Exact rank celebration CSS/JS with synthetic app state, no Firebase or business data',
        'status':'running','tests':[],'errors':[],'screenshots':[],'videos':[],
        'sources':{name:digest(args.source_root/name) for name in ['rank-celebration.css','rank-celebration.js']},
        'preview':preview.name}
    def save():
        (args.output/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    def passed(name,detail=None):
        item={'name':name,'status':'passed'}
        if detail is not None:item['detail']=detail
        report['tests'].append(item); print('PASS',name,flush=True);save()
    from playwright.sync_api import sync_playwright
    requests=[]; errors=[]
    def wire(page):
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('request',lambda request:requests.append(request.url))
        page.route('**/*',lambda route:route.abort())
    try:
        with sync_playwright() as p:
            executable=args.chromium or shutil.which('chromium') or shutil.which('google-chrome')
            options={'headless':True,'chromium_sandbox':True}
            if executable:options['executable_path']=executable
            browser=p.chromium.launch(**options)
            report['browser']=browser.version
            # Dedicated short movie: open, rocket launch/bursts, automatic dismissal.
            video_options={} if args.no_video else {'record_video_dir':str(args.output/'video'),'record_video_size':{'width':1280,'height':800}}
            context=browser.new_context(viewport={'width':1280,'height':800},**video_options)
            page=context.new_page();wire(page);page.set_content(html,wait_until='load')
            page.locator('#preview-again').click();page.wait_for_timeout(1000)
            snapshot=page.evaluate('fixture.snapshot()');centered(snapshot)
            file=args.output/'desktop-fireworks.png';page.screenshot(path=str(file));png_size(file)
            report['screenshots'].append(file.name)
            page.wait_for_timeout(1100)
            snapshot=page.evaluate('fixture.snapshot()')
            sounds=snapshot['sound'];kinds=[x['kind'] for x in sounds]
            assert 'launch' in kinds and 'burst' in kinds, sounds
            assert kinds.count('launch')<=6 and kinds.count('burst')<=6, sounds
            assert kinds.index('launch')<kinds.index('burst'),sounds
            assert snapshot['sources']<=24 and snapshot['nodes']<=32, snapshot
            passed('Real RAF launches/bursts use synchronized procedural sound calls',sounds)
            page.wait_for_timeout(1900);cleanup_assert(page.evaluate('fixture.snapshot()'))
            passed('Automatic completion removes DOM, RAF, timer, lifecycle and sound resources')
            # Force a fresh compositor snapshot after removal before flushing screencast.
            # Some Chrome screencasts otherwise retain their last animation frame.
            page.locator('#game-rank-celebration').wait_for(state='detached')
            file=args.output/'desktop-dismissed.png';page.screenshot(path=str(file));png_size(file)
            report['screenshots'].append(file.name)
            page.wait_for_timeout(200)
            passed('Post-dismissal screenshot verifies unobstructed work surface')
            video=page.video;context.close()
            if video:
                path=Path(video.path());assert path.exists() and path.stat().st_size>3000
                report['videos'].append(str(path.relative_to(args.output)))
                passed('Short real-browser celebration video recorded')
            context=browser.new_context(viewport={'width':390,'height':844})
            page=context.new_page();wire(page);page.set_content(html,wait_until='load')
            # A genuine user gesture unlocks normal WebAudio; autoplay policy is not bypassed.
            page.locator('#preview-again').click();page.wait_for_timeout(80);page.evaluate('fixture.clear()');page.wait_for_timeout(30)
            for name,width,height,rank_index in [('mobile',390,844,5),('narrow-mobile',320,568,4),('landscape',844,390,3)]:
                page.set_viewport_size({'width':width,'height':height})
                page.evaluate('(i)=>fixture.show(i)',rank_index);page.wait_for_timeout(900)
                snapshot=page.evaluate('fixture.snapshot()');centered(snapshot)
                file=args.output/(name+'-fireworks.png');page.screenshot(path=str(file));assert png_size(file)==(width,height)
                report['screenshots'].append(file.name)
                close=page.get_by_role('button',name='Закрыть поздравление')
                assert close.is_visible()
                box=close.bounding_box();assert box and box['width']>=32 and box['height']>=32,box
                close.click();page.wait_for_timeout(60);cleanup_assert(page.evaluate('fixture.snapshot()'))
                passed(name+' centered, contained and immediately dismissible',{'viewport':[width,height]})
            page.set_viewport_size({'width':390,'height':844})
            # Check every existing rank, including welcome and longest label.
            for index in range(6):
                page.evaluate('(i)=>fixture.show(i)',index);page.wait_for_timeout(520)
                centered(page.evaluate('fixture.snapshot()'))
                assert page.locator('#game-rank-celebration').inner_text().strip()
                page.keyboard.press('Escape');page.wait_for_timeout(50);cleanup_assert(page.evaluate('fixture.snapshot()'))
            passed('All six rank cards fit and Escape closes without focus trapping')
            page.locator('#work-action').focus()
            page.evaluate('fixture.show(3)');page.wait_for_timeout(520)
            assert page.evaluate('document.activeElement.id')=='work-action'
            # Work must remain actionable even directly behind the card.
            page.locator('#work-action').evaluate("el=>{el.style.position='fixed';el.style.top='50%';el.style.left='50%';el.style.transform='translate(-50%,-50%)';}")
            page.mouse.click(195,422)
            assert page.locator('#action-count').inner_text()=='1'
            passed('Operational button stays clickable through card; focus is not stolen')
            page.locator('#work-action').evaluate("el=>el.removeAttribute('style')")
            for index in range(12):page.evaluate('(i)=>fixture.show(i%6)',index)
            snap=page.evaluate('fixture.snapshot()')
            assert snap['noticeCount']==1 and snap['canvasCount']<=1,snap
            page.evaluate('fixture.clear()');page.wait_for_timeout(100);cleanup_assert(page.evaluate('fixture.snapshot()'))
            passed('12 consecutive previews replace prior resources without duplication')
            # Real source lifecycle reacts to synthetic app state (not backend auth).
            for name,changes,reset in [
                ('account switch',{'uid':'fixture-other'},{'uid':'fixture-user'}),
                ('access revocation',{'active':False},{'active':True}),
                ('admin revocation during preview',{'admin':False},{'admin':True}),
                ('tab navigation',{'tab':'tab-other'},{'tab':'tab-main'}),
                ('document hidden',{'hidden':True},{'hidden':False})]:
                page.evaluate('fixture.show(3)');page.wait_for_timeout(150)
                page.evaluate('(v)=>fixture.set(v)',changes);page.wait_for_timeout(350)
                cleanup_assert(page.evaluate('fixture.snapshot()'))
                page.evaluate('(v)=>fixture.set(v)',reset)
                passed(name+' cleans up the active celebration')
            for event in ['pagehide','popstate','hashchange']:
                page.evaluate('fixture.show(3)');page.wait_for_timeout(100)
                page.evaluate('(event)=>window.dispatchEvent(new Event(event))',event);page.wait_for_timeout(70)
                cleanup_assert(page.evaluate('fixture.snapshot()'))
                passed(event+' closes celebration')
            page.evaluate('fixture.set({sound:false});fixture.show(3)');page.wait_for_timeout(900)
            snap=page.evaluate('fixture.snapshot()');assert snap['canvas'] and snap['sources']==0 and snap['nodes']==0 and not snap['bus'],snap
            page.evaluate('fixture.clear();fixture.set({sound:true,effects:false});fixture.show(3)');page.wait_for_timeout(600)
            snap=page.evaluate('fixture.snapshot()');assert snap['notice'] and not snap['canvas'] and not snap['frame'],snap
            assert len(snap['sound'])==1 and snap['sound'][0]['kind']=='cue' and snap['sources']<=1 and snap['bus'],snap
            passed('Sound/effects switches are honored independently')
            page.evaluate('fixture.clear();fixture.set({effects:true})')
            page.emulate_media(reduced_motion='reduce');page.evaluate('fixture.show(3)');page.wait_for_timeout(520)
            snap=page.evaluate('fixture.snapshot()');assert snap['notice'] and not snap['canvas'] and not snap['frame'],snap
            animation=page.locator('#game-rank-celebration').evaluate('el=>getComputedStyle(el).animationName')
            assert animation=='none',animation
            assert len(snap['sound'])==1 and snap['sound'][0]['kind']=='cue' and snap['sources']<=1 and snap['bus'],snap
            file=args.output/'mobile-reduced-motion.png';page.screenshot(path=str(file));png_size(file);report['screenshots'].append(file.name)
            page.evaluate('fixture.clear()');page.emulate_media(reduced_motion='no-preference')
            passed('Reduced motion keeps readable centered card with no fireworks/entry animation')
            page.evaluate('fixture.show(3)');page.wait_for_timeout(550)
            page.evaluate('fixture.set({sound:false,effects:false})');page.wait_for_timeout(350)
            snap=page.evaluate('fixture.snapshot()');assert not snap['canvas'] and snap['sources']==0 and snap['nodes']==0 and not snap['bus'],snap
            page.evaluate('fixture.clear();fixture.set({sound:true,effects:true})')
            passed('Disabling sound/effects mid-celebration stops active effects')
            page.evaluate('''async()=>{await fixture.show(3);const until=performance.now()+2300;while(performance.now()<until){};}''')
            page.wait_for_timeout(200)
            snap=page.evaluate('fixture.snapshot()');assert snap['sound']==[] and snap['sources']==0,snap
            page.evaluate('fixture.clear()')
            passed('2300 ms blocked main thread skips stale rocket/burst audio rather than replaying it')
            page.evaluate('fixture.setSuspended(true)');page.evaluate('fixture.showWithoutUnlock(3)');page.wait_for_timeout(2300)
            snap=page.evaluate('fixture.snapshot()');assert snap['audioState']=='suspended' and snap['sources']==0 and snap['nodes']==0,snap
            page.evaluate('fixture.setSuspended(false)');page.wait_for_timeout(300)
            snap=page.evaluate('fixture.snapshot()');assert snap['sources']==0 and snap['nodes']==0,snap
            page.evaluate('fixture.clear()')
            passed('Suspended real AudioContext remains silent and late resume does not replay old bursts')
            page.evaluate('fixture.show(3)');page.wait_for_timeout(620)
            page.evaluate('fixture.set({sound:false})');page.wait_for_timeout(1700)
            snap=page.evaluate('fixture.snapshot()');assert snap['sources']==0 and not snap['bus'],snap
            page.evaluate('fixture.set({sound:true})');page.wait_for_timeout(300)
            snap=page.evaluate('fixture.snapshot()');assert snap['sources']==0 and not snap['bus'],snap
            page.evaluate('fixture.clear()')
            passed('Late unmute does not replay missed firework sounds')
            page.evaluate('fixture.show(3,false)');page.wait_for_timeout(200)
            page.evaluate('fixture.set({mode:false})');page.wait_for_timeout(200);cleanup_assert(page.evaluate('fixture.snapshot()'))
            page.evaluate('fixture.set({mode:true})')
            passed('Game mode off cancels non-preview card and effects')
            report['audio']={}
            for mode in ['fireworks','cue']:
                rendered=page.evaluate('(mode)=>fixture.offlineRender(mode)',mode)
                wav=base64.b64decode(rendered.pop('wav'));(args.output/(mode+'-procedural.wav')).write_bytes(wav)
                assert wav[:4]==b'RIFF' and wav[8:12]==b'WAVE' and len(wav)>100000
                assert rendered['nonFinite']==0 and rendered['clipped']==0,rendered
                assert .001<rendered['peak']<.98,rendered
                assert .0001<rendered['rms']<.3,rendered
                assert rendered['maxDelta']<.2,rendered
                assert max(w['rms'] for w in rendered['windows'][-8:])<.002,rendered
                report['audio'][mode]=rendered;passed(mode+' OfflineAudioContext PCM is finite, audible, unclipped and fades to silence',{'peak':rendered['peak'],'rms':rendered['rms'],'clipped':rendered['clipped'],'maxDelta':rendered['maxDelta']})
            cleanup_assert(page.evaluate('fixture.snapshot()'))
            # Missing/broken optional WebAudio APIs must never break the card.
            for name,prelude in [
                ('missing AudioContext','window.AudioContext=undefined;window.webkitAudioContext=undefined;'),
                ('AudioContext constructor denied',"window.AudioContext=function(){throw Error('Audio unavailable')};window.webkitAudioContext=undefined;")]:
                bad=context.new_page();wire(bad)
                bad.set_content(html.replace("(() => {", "(() => {\n"+prelude,1),wait_until='load')
                bad.locator('#preview-again').click();bad.wait_for_timeout(520);centered(bad.evaluate('fixture.snapshot()'))
                bad.evaluate('fixture.clear()');bad.wait_for_timeout(50);cleanup_assert(bad.evaluate('fixture.snapshot()'));bad.close();passed(name+' gracefully falls back to visuals')
            assert not requests,requests
            assert not errors,errors
            passed('No external requests or unhandled browser errors',{'requests':len(requests),'errors':len(errors)})
            context.close();browser.close()
        report['status']='passed';report['testsPassed']=len(report['tests']);save()
        print(json.dumps({'status':report['status'],'tests':len(report['tests']),'evidence':str(args.output)},ensure_ascii=False),flush=True)
        return 0
    except Exception as error:
        report['status']='failed';report['errors'].append(str(error));report['traceback']=traceback.format_exc();save()
        print(report['traceback'],file=sys.stderr)
        return 1

if __name__=='__main__':sys.exit(main())
