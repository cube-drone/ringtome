
import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import { ShieldUser, KeyRound, Phone, PhoneIncoming, Mail, MailCheck, Lock, UserCog, Superscript } from 'lucide-preact';

const html = htm.bind(h);

const tagToIcon = {
    'owner': ShieldUser,
    'has_password': KeyRound,
    'has_phone': Phone,
    'phone_verified': PhoneIncoming,
    'has_email': Mail,
    'email_verified': MailCheck,
    'locked': Lock,
    'admin': UserCog,
    'super_admin': Superscript,
};

const tagToName = {
    'owner': 'Owner',
    'has_password': 'Has Password',
    'has_phone': 'Has Phone Number',
    'phone_verified': 'Phone Verified',
    'has_email': 'Has Email Address',
    'email_verified': 'Email Verified',
    'locked': 'Locked',
    'admin': 'Admin',
    'super_admin': 'Super Admin',
};

const tagToDescription = {
    'owner': 'User is the owner',
    'has_password': 'User has a password set',
    'has_phone': 'User has a phone number set',
    'phone_verified': 'User phone number is verified',
    'has_email': 'User has an email address set',
    'email_verified': 'User email address is verified',
    'locked': 'User can not log in or access their account',
    'admin': 'User has admin privileges',
    'super_admin': 'User is a super-admin from outside the community',
};

const Tag = ({tag}) => {

    let icon = tagToIcon[tag];
    if(!icon){
        console.warn(`No icon found for tag: ${tag}`);
        icon = () => null; // Fallback to a no-op component
    }
    let tagName = tagToName[tag];
    if(!tagName){
        console.warn(`No name found for tag: ${tag}`);
        tagName = tag; // Fallback to the tag itself
    }
    let tagDescription = tagToDescription[tag];
    if(!tagDescription){
        console.warn(`No description found for tag: ${tag}`);
        tagDescription = 'No description available'; // Fallback to a generic message
    }

    return html`
    <span class="tag" title=${tagDescription}>
        <${icon} class="tag-icon" size="16" strokeWidth="3" />
        <span class="tag-link">
            ${tagName}
        </span>

    </span>
    `;
};

export default Tag;