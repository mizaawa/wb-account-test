const assert = require('node:assert/strict');

async function checkRealmSelect(page) {
  const trigger = page.getByRole('combobox', { name: '默认账号版本' });
  const list = page.getByRole('listbox', { name: '默认账号版本' });
  const cn = '中国版 · WorkBuddy', intl = '国际版 · WorkBuddy';
  assert.equal(await trigger.innerText(), cn);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  const pick = locator => touch ? locator.tap() : locator.click();
  const initialSize = page.viewportSize();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ ...initialSize, width });
    for (const open of [false, true]) {
      if (open) await pick(trigger);
      assert.equal(await trigger.getAttribute('aria-expanded'), String(open));
      // Measure the drawn path, not just the SVG element or its flex slot.
      const geometry = await trigger.evaluate(async el => {
        const icon = el.querySelector('.realm-chevron');
        await Promise.all(icon.getAnimations().map(a => a.finished));
        const rect = node => node.getBoundingClientRect();
        const mid = r => r.top + r.height / 2;
        const box = rect(el), text = rect(el.querySelector('.realm-value')), glyph = rect(icon.querySelector('path'));
        return { dy: mid(glyph) - mid(box), textDy: mid(glyph) - mid(text), gap: glyph.left - text.right, right: box.right - glyph.right };
      });
      const where = 'width=' + width + ' expanded=' + open + ' ' + JSON.stringify(geometry);
      assert.ok(Math.abs(geometry.dy) <= 0.5 && Math.abs(geometry.textDy) <= 0.5, where);
      assert.ok(geometry.gap >= 4 && geometry.right >= 6, where);
    }
    const menu = await list.boundingBox(), box = await trigger.boundingBox();
    assert.ok(Math.abs(menu.x - box.x) <= 1 && Math.abs(menu.width - box.width) <= 1, 'popup must line up with its trigger');
    assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1, 'popup overflow at ' + width);
    assert.ok(menu.y >= box.y + box.height, 'popup should not obscure the trigger');
    await trigger.press('Escape');
  }
  await page.setViewportSize(initialSize);
  await pick(trigger);
  const selected = list.getByRole('option', { name: cn, selected: true });
  assert.ok(await selected.isVisible());
  assert.equal(await selected.locator('svg').count(), 1, 'show a checkmark on the selected realm');
  assert.notEqual(await selected.evaluate(el => getComputedStyle(el).backgroundColor), await list.evaluate(el => getComputedStyle(el).backgroundColor));
  await pick(list.getByRole('option', { name: intl }));
  assert.equal(await trigger.innerText(), intl);
  assert.equal(await list.isVisible(), false);
  await trigger.press('Space');
  await trigger.press('ArrowUp');
  assert.equal(await trigger.getAttribute('aria-activedescendant'), 'realm-cn');
  await trigger.press('Escape');
  assert.equal(await trigger.innerText(), intl, 'Escape cancels uncommitted navigation');
  await trigger.press('Home');
  await trigger.press('Enter');
  assert.equal(await trigger.innerText(), cn);
  await trigger.press('ArrowDown');
  await trigger.press('End');
  await trigger.press('Space');
  assert.equal(await trigger.innerText(), intl);
  await trigger.press('Home');
  await trigger.press('Tab');
  assert.equal(await trigger.innerText(), cn);
  assert.equal(await page.locator('#credential-input').evaluate(el => el === document.activeElement), true);
  await pick(trigger);
  await pick(page.getByRole('heading', { name: '添加你的凭证' }));
  assert.equal(await list.isVisible(), false);
  await pick(trigger);
  await pick(list.getByRole('option', { name: intl })); // Used as the fallback realm by the import test.
  return trigger;
}

module.exports = { checkRealmSelect };
