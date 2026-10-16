// Where a post goes (PROJECT_PLAN's Post visibility slice 2, Contact tags rulings 4, 5 and 7;
// plans/GROUPS.md, section 7): one choice, as the feed's composer and the publish bar hold it, and
// the publish wishes it means. Values in, values out.
//
//   ''            everyone - an open post
//   'onward'      people I trust, and whoever they trust (the trust list, the share button left on)
//   'trusted'     people I trust (the seal's default list)
//   'mentioned'   the people the words' user cards name
//   'tag:<tag>'   a contact tag - "family" - narrower than trust
//   'group:<id>'  one of your groups: a place, not a seal

/// The group a choice posts to, or null.
export const groupOfChoice = (choice) =>
    choice && choice.startsWith('group:') ? choice.slice(6) : null;

/// The seal a choice asks the publish door for: `{ trusted_only, audience? }`, or null for an open
/// post or a group, which the group's own door takes.
export const sealOfChoice = (choice) => {
    if (!choice || groupOfChoice(choice)) return null;
    if (choice === 'trusted') return { trusted_only: true };
    if (choice === 'onward') return { trusted_only: true, audience: '@onward' };
    if (choice === 'mentioned') return { trusted_only: true, audience: '@mentioned' };
    if (choice.startsWith('tag:')) return { trusted_only: true, audience: choice.slice(4) };
    return null;
};

/// The choice a draft already stands at: the audience its last publish named, or the seal wish a
/// copy of a sealed post carries (copyinto.js) - else everyone.
export const choiceOfDraft = (fields) => {
    const audience = ((fields && fields.audience) || '').trim();
    if (audience === '@onward') return 'onward';
    if (audience === '@mentioned') return 'mentioned';
    if (audience) return `tag:${audience}`;
    if (fields && fields.seal === 'yes') return 'trusted';
    return '';
};

/// The wishes a publish of a draft sends for `choice`. A seal is asked for outright; so is going
/// open over a draft that stands sealed, which says so, and clears its standing list - the choice
/// shown is the word. Otherwise nothing, so an open post's body stays as it always was.
export const publishWishes = (choice, fields) => {
    const seal = sealOfChoice(choice);
    if (seal) return { audience: '', ...seal };
    if (!groupOfChoice(choice) && choiceOfDraft(fields) !== '')
        return { trusted_only: false, audience: '' };
    return {};
};
