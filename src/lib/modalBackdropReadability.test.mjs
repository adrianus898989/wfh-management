import assert from 'node:assert/strict'
import {readdir,readFile} from 'node:fs/promises'
import test from 'node:test'

const srcDir=new URL('../',import.meta.url)
const shared=await readFile(new URL('../stable-layout-hotfix.css',import.meta.url),'utf8')
const cssFiles=(await readdir(srcDir)).filter(name=>name.endsWith('.css'))
const cssSources=await Promise.all(cssFiles.map(async name=>({
  name,
  source:await readFile(new URL(`../${name}`,import.meta.url),'utf8'),
})))

const policyStart=shared.indexOf('/*\n * Modal readability policy')
const policy=shared.slice(policyStart)

test('shared modal policy disables only backdrop blur',()=>{
  assert.ok(policyStart>=0)
  for(const selector of [
    '.modal-mask','.detail-mask','.activation-code-mask','.analytics-detail-mask',
    '.admin-alert-rule-mask','.wfh-chart-summary-mask','.rp-workload-modal-mask','.ot-backdrop',
    '[class*="modal-backdrop"]','[class*="modal-mask"]','[class*="drawer-backdrop"]',
    '[class*="drawer-mask"]','[class*="lightbox"]',
  ])assert.ok(policy.includes(selector),`missing modal policy selector ${selector}`)
  assert.match(policy,/-webkit-backdrop-filter:none!important/)
  assert.match(policy,/backdrop-filter:none!important/)

  const body=policy.slice(policy.indexOf('{')+1,policy.indexOf('}'))
  assert.doesNotMatch(body,/background\s*:|opacity\s*:|pointer-events\s*:|z-index\s*:/)
})

test('every currently blurred application overlay is covered by the no-blur policy',()=>{
  const overlayRule=/([^{}]+)\{[^{}]*backdrop-filter\s*:\s*blur\([^)]*\)[^{}]*\}/g
  const overlayNames=[]
  for(const {name,source} of cssSources){
    for(const match of source.matchAll(overlayRule)){
      const selector=match[1].trim()
      if(!/(?:modal|mask|backdrop|drawer-backdrop|lightbox)/.test(selector))continue
      if(/[>+~]/.test(selector))continue // sticky content inside a dialog is not the page overlay
      overlayNames.push(`${name}: ${selector}`)
      const covered=
        /modal-backdrop/.test(selector)
        ||/modal-mask/.test(selector)
        ||/drawer-backdrop/.test(selector)
        ||/drawer-mask/.test(selector)
        ||/lightbox/.test(selector)
        ||['.modal-mask','.detail-mask','.activation-code-mask','.analytics-detail-mask',
          '.admin-alert-rule-mask','.wfh-chart-summary-mask','.rp-workload-modal-mask','.ot-backdrop']
          .some(token=>selector.includes(token))
      assert.equal(covered,true,`blurred overlay is not covered: ${name}: ${selector}`)
    }
  }
  assert.ok(overlayNames.length>=10,`expected a full overlay audit, found ${overlayNames.length}`)
})
