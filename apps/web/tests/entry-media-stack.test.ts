import { describe, expect, it } from 'vitest';
import {
  entryCardMediaRef,
  entryStackLayerStyle,
  entryStackLayers,
} from '../src/entry-media-stack.js';

describe('Entry media stack', () => {
  it('routes managed Entry card media through the thumbnail resolver', () => {
    expect(entryCardMediaRef('/api/assets/entries/42/cover.png'))
      .toBe('/api/thumbnails/entries/42/cover.png');
    expect(entryCardMediaRef('https://example.com/remote.jpg'))
      .toBe('https://example.com/remote.jpg');
  });

  it('lays a single Entry cover flat across the card media frame', () => {
    const layers = entryStackLayers({
      coverRef: '/cover.webp',
      previewRefs: [],
    });

    expect(layers).toEqual(['/cover.webp']);
    expect(entryStackLayerStyle(0, layers.length)).toMatchObject({
      left: '0%',
      top: '0%',
      width: '100%',
      height: '100%',
      maxWidth: '100%',
      objectFit: 'contain',
      transform: 'none',
    });
  });

  it('keeps natural-aspect pages narrow and fans previews in 3D', () => {
    const layers = entryStackLayers({
      coverRef: '/cover.webp',
      previewRefs: [
        '/preview.webp',
        '/preview-2.webp',
        '/preview-3.webp',
        '/preview-4.webp',
        '/preview.webp',
      ],
    });

    expect(layers).toEqual([
      '/cover.webp',
      '/preview.webp',
      '/preview-2.webp',
      '/preview-3.webp',
    ]);

    const front = entryStackLayerStyle(0, layers.length);
    const next = entryStackLayerStyle(1, layers.length);
    const back = entryStackLayerStyle(3, layers.length);

    expect(front).toMatchObject({
      width: 'auto',
      height: '94%',
      maxWidth: '82%',
      objectFit: 'contain',
      background: 'transparent',
      transform: 'rotateY(30deg)',
    });
    const percent = (style: Record<string, string>, property: string): number => {
      const value = style[property];
      if (!value) throw new Error(`Missing ${property}`);
      return Number.parseFloat(value);
    };
    expect(percent(next, 'left')).toBeLessThan(percent(front, 'left'));
    expect(percent(next, 'height')).toBeLessThan(percent(front, 'height'));
    expect(percent(back, 'left')).toBeLessThan(percent(next, 'left'));
    expect(back.zIndex).toBe('1');
  });
});
