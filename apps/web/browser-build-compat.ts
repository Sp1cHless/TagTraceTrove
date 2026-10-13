import { atRule, type Plugin } from 'postcss';

/** Keep layouts and readable surfaces on pre-104 Android WebViews. */
export function browserCssCompatibility(): Plugin {
  return {
    postcssPlugin: 't3-browser-compatibility',
    Once(root) {
      root.walkAtRules('container', (query) => {
        if (!/^\((?:min|max)-width:/.test(query.params)) return;
        const fallback = atRule({ name: 'supports', params: 'not (container-type: inline-size)' });
        fallback.append(query.clone({ name: 'media' }));
        query.after(fallback);
      });
      root.walkDecls((declaration) => {
        if (/\d(?:d|s|l)vh\b/.test(declaration.value)) {
          declaration.cloneBefore({ value: declaration.value.replace(/(\d)(?:d|s|l)vh\b/g, '$1vh') });
        }
      });
      // Unsupported functions in custom properties invalidate their consumers
      // at computed-value time, so guard modern values with @supports.
      root.walkRules((rule) => {
        if (rule.parent?.type === 'atrule' && rule.parent.name === 'supports'
          && rule.parent.params.includes('color-mix')) return;
        const mixed = rule.nodes.filter(node => node.type === 'decl' && node.value.includes('color-mix('));
        if (mixed.length === 0) return;
        const modern = rule.clone({ nodes: mixed.map(node => node.clone()) });
        for (const node of mixed) {
          if (node.type !== 'decl') continue;
          const fallback = node.prop.startsWith('border') ? 'var(--border-subtle)'
            : node.prop === 'color' ? 'var(--text-muted)'
            : /outline|shadow/.test(node.prop) ? 'var(--accent)'
            : 'var(--surface-muted)';
          let value = node.value;
          let start: number;
          while ((start = value.indexOf('color-mix(')) !== -1) {
            let end = start + 'color-mix'.length;
            let depth = 0;
            do {
              if (value[end] === '(') depth += 1;
              if (value[end] === ')') depth -= 1;
              end += 1;
            } while (depth > 0 && end < value.length);
            const expression = value.slice(start, end);
            const scrim = /color-mix\(in srgb,\s*#000\s+(\d+)%,\s*transparent\)/.exec(expression);
            const replacement = scrim ? `rgba(0, 0, 0, ${Number(scrim[1]) / 100})` : fallback;
            value = value.slice(0, start) + replacement + value.slice(end);
          }
          node.value = value;
        }
        const supported = atRule({ name: 'supports', params: '(color: color-mix(in srgb, black, white))' });
        supported.append(modern);
        rule.after(supported);
      });
    },
  };
}
