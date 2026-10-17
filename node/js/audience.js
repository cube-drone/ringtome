// Where a post goes, as one select (pure/audience.js says what each choice means): the feed's
// composer and the publish bar Writer and Drawing share draw the same one (Curtis, 2026-10-16: the
// bar's "trusted only" box had fallen behind the feed's lists). It draws only the options; each
// surface wraps it in its own words.
import { h } from 'preact';
import htm from 'htm';

import { t } from './i18n.js';

const html = htm.bind(h);

/// `sealing` - the Market's Sealed posts & audiences is owned, so the lists are offered.
/// `fixed` - a copy of a sealed post without it: its own seal is the one list it may keep, and
///           never everyone (UNLOCKS.md: its words were never meant to go out in the open).
/// `tags` - the reader's contact tags; `groups` - their groups (pure/groups.js `groupFeeds`);
/// `mentions` - the words can mention people, so "the people mentioned" means something.
export const AudienceSelect = ({
    value,
    onChange,
    sealing,
    fixed = '',
    tags = [],
    groups = [],
    mentions = true,
    className,
    title,
}) => {
    const offered = (choice) => sealing || choice === fixed;
    // A list a draft stands at stays offered, even once nobody wears the tag.
    const standing = [value, fixed].filter((c) => c && c.startsWith('tag:')).map((c) => c.slice(4));
    const tagged = [...new Set([...tags, ...standing])].filter((tag) => offered(`tag:${tag}`));
    // Chosen out here: inside the template, a quoted choice reads to the strings cop as copy.
    const onward = offered('onward');
    const trusted = offered('trusted');
    const mentioned = mentions && offered('mentioned');
    return html`<select
        class=${className}
        title=${title}
        value=${value}
        onChange=${(e) => onChange(e.currentTarget.value)}
    >
        ${(sealing || !fixed) && html`<option value="">${t('audience.everyone', 'everyone')}</option>`}
        ${onward && html`<option value="onward">${t('audience.people-i-trust-and-onward', 'people I trust, and onward')}</option>`}
        ${trusted && html`<option value="trusted">${t('audience.people-i-trust', 'people I trust')}</option>`}
        ${mentioned && html`<option value="mentioned">${t('audience.the-people-mentioned', 'the people mentioned')}</option>`}
        ${
            /* The people you've tagged, by tag ("hot pot team"), in a run of their own, as your
            groups are (Curtis, 2026-10-16). */ ''
        }
        ${
            tagged.length > 0 &&
            html`<optgroup label=${t('audience.your-tags', 'your tags')}>
                ${tagged.map((tag) => html`<option value=${`tag:${tag}`} key=${tag}>${tag}</option>`)}
            </optgroup>`
        }
        ${
            groups.length > 0 &&
            html`<optgroup label=${t('audience.your-groups', 'your groups')}>
                ${groups.map((g) => html`<option value=${`group:${g.group}`} key=${g.group}>${g.name}</option>`)}
            </optgroup>`
        }
        ${
            /* In public, as one of your public groups (plans/PUBLIC_GROUPS.md): your own open post,
            the group's too, reaching your followers and the group's. */ ''
        }
        ${
            groups.some((g) => g.public) &&
            html`<optgroup label=${t('audience.in-public-as-a-group', 'in public, as a group')}>
                ${groups
                    .filter((g) => g.public)
                    .map(
                        (g) =>
                            html`<option value=${`as-group:${g.group}`} key=${`as-${g.group}`}>${g.name}</option>`,
                    )}
            </optgroup>`
        }
    </select>`;
};
