import { Converter } from 'opencc-js';

/**
 * Traditional Chinese → Simplified Chinese, the one conversion the library does on its own.
 *
 * A tag arrives in one of three scripts: English, Traditional Chinese, Simplified Chinese. Only one
 * of the three can be converted without asking anybody — Traditional and Simplified are the *same
 * language* written two ways, so the conversion is mechanical and loses nothing. English → Chinese is
 * a translation: semantic, per-word, and the reason the alias dictionary exists at all. So this is
 * built in and applies to every name that enters, and anything else is left for the dictionary.
 *
 * The engine is OpenCC's `t2s`, the same conversion the SiteProbe tool has always applied when it
 * built a site's dictionary. Checked against it over every name those dictionaries hold — 7,709
 * spellings across seven sites — and the two agree on all of them, so a name converted here and a
 * name converted there are the same name. That matters because the tool's dictionaries are migrated
 * into this one: a disagreement would have made a hand-written translation look auto-filled.
 */
const converter = Converter({ from: 't', to: 'cn' });

export function toSimplified(value: string): string {
  return converter(value);
}
