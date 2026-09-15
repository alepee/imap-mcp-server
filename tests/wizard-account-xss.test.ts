import { expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

it('renders malicious account values as text and keeps ids out of inline handlers', () => {
  const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const body = source.match(/function renderAccountTable\(container, accounts\) \{([\s\S]*?)\n\}/)![1];
  const elements: any[] = [];
  const document = { createElement: (tag: string) => {
    const element = { tag, textContent: '', children: [] as any[], events: {} as Record<string, Function>,
      set innerHTML(_: string) { throw new Error('Dynamic HTML is forbidden'); },
      appendChild(child: any) { this.children.push(child); },
      addEventListener(name: string, handler: Function) { this.events[name] = handler; },
    };
    elements.push(element);
    return element;
  } };
  const account = { id: "');alert(1);//", name: '<img src=x onerror=alert(1)>', user: '<svg onload=alert(2)>', host: '<script>alert(3)</script>' };
  const edit = vi.fn();
  const remove = vi.fn();
  const container = { replaceChildren: vi.fn() };
  new Function('document', 'editAccount', 'removeAccount', 'container', 'accounts', body)(document, edit, remove, container, [account]);
  const cells = elements.filter(el => el.tag === 'td');
  expect(cells.slice(0, 3).map(el => el.textContent)).toEqual([account.name, account.user, account.host]);
  const buttons = elements.filter(el => el.tag === 'button');
  buttons[0].events.click();
  buttons[1].events.click();
  expect(edit).toHaveBeenCalledWith(account.id);
  expect(remove).toHaveBeenCalledWith(account.id);
  expect(container.replaceChildren).toHaveBeenCalledOnce();
});
