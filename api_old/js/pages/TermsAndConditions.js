import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { marked } from 'marked';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';

const termsMarkdown = `

Welcome to our website. By accessing or using this site, you agree to comply with the following Terms of Service, Code of Conduct, and Privacy Policy (collectively, "ToSCoCPP").

We, Cube Drone ([https://cube-drone.com](https://cube-drone.com)), operate this website and reserve the right to modify these terms at any time. Continued use of the site constitutes acceptance of the most current version of this document.

---

## 1. General Terms

1.1 **Agreement to Terms**
By using this site, you agree to all terms within this document, even those that may appear contradictory. If any provision is found to be unenforceable, the remainder of the terms remain valid.

1.2 **Changes to Terms**
These terms may be updated at any time. If significant changes are made, we will attempt to notify you via email if provided. Your continued use of the site signifies acceptance of any updates.

1.3 **Non-Waiver**
Failure to enforce any term does not constitute a waiver of our right to enforce it later.

---

## 2. Code of Conduct

2.1 **Respect and Civility**
Users must engage respectfully. Harassment, hate speech, or abusive behavior will not be tolerated.

2.2 **Age Restrictions**
Users must be at least 13 years old to use the site. Certain content may require users to be 18+.

2.3 **Prohibited Content**
Users may not post illegal, violent, pornographic, or otherwise harmful content. Content featuring minors in an adult context is strictly prohibited.

2.4 **No Impersonation**
Users may not falsely claim affiliation with the site or impersonate others.

2.5 **No Unauthorized Access**
Users may not engage in data scraping, hacking, or automated access without permission.

2.6 **No Copyright Infringement**
Users must only post content they own or have permission to use.

2.7 **Privacy and Personal Information**
Users must respect the privacy of others and not disclose private or confidential information without consent.

2.8 **No Malicious Activities**
The distribution of malware, spyware, or other harmful software is prohibited.

---

## 3. Account Management

3.1 **Non-Transferable Accounts**
User accounts are personal and cannot be sold, shared, or transferred.

3.2 **Account Deletion**
Inactive accounts may be removed after three years. Accounts may also be terminated at our discretion.

---

## 4. Enforcement

4.1 **Investigation and Action**
We reserve the right to investigate violations and take appropriate action, including banning users or reporting illegal activities to authorities.

4.2 **Content Moderation**
We may modify or remove any content that violates these terms.

---

## 5. Liability and Disclaimers

5.1 **Indemnification**
Users agree to indemnify Cube Drone against claims arising from their violation of these terms.

5.2 **No Warranty**
The site is provided "as is" without warranties of any kind.

5.3 **Limitation of Liability**
We are not liable for indirect damages arising from the use of this site.

---

## 6. Governing Law and Disputes

6.1 **Jurisdiction**
These terms are governed by the laws of British Columbia, Canada. Any disputes must be resolved in courts located in British Columbia.

6.2 **No Class Actions**
Users agree to bring disputes individually and waive rights to participate in class actions.

---

## 7. Privacy Policy

7.1 **Data Collection**
We collect minimal user data necessary for site functionality and security.

7.2 **Cookies**
We use cookies to maintain user sessions but do not engage in extensive tracking.

7.3 **Third-Party Links**
We are not responsible for external content linked on our site.

7.4 **Data Retention**
User data is retained as long as necessary for site operation, with inactive accounts being purged after three years.

---

## 8. Termination

8.1 **User Termination**
Users may terminate their accounts at any time. Termination does not affect obligations or rights under these terms.

8.2 **Site Termination**
We reserve the right to terminate or restrict access to the site for any reason.

---

## 9. Restricted Access: Canadian Users Only

### 9.1 Eligibility
Our services are intended solely for residents of Canada. By accessing or using our platform, you confirm that you:
- Are a legal resident of Canada;
- Are physically located in Canada when using our services; and
- Have provided accurate, complete, and current information reflecting your Canadian residency.

### 9.2 Geo-Restrictions & Enforcement
We reserve the right to:
- Block access from non-Canadian IP addresses and restrict usage from outside Canada.
- Require users to verify their Canadian residency through billing information, phone number validation, or other means.
- Terminate accounts that, in our sole discretion, do not comply with these residency requirements.

### 9.3 No Availability Outside Canada
We do not offer or market our services outside Canada. If you are not a Canadian resident, you must not use our services. We disclaim all liability for any use outside Canada and make no representations that our platform complies with non-Canadian laws, including data protection, privacy, or consumer regulations.

### 9.4 Non-Canadian Users & Data Collection
If you are not a Canadian resident but still access our services:
- You acknowledge that you are doing so at your own risk, and
- You agree that Canadian laws (including the Personal Information Protection and Electronic Documents Act (PIPEDA)) govern our handling of your data, not foreign privacy laws such as GDPR, CCPA, or others.

---

By using this site, you acknowledge that you have read, understood, and agreed to these Terms of Service, Code of Conduct, and Privacy Policy.



`;

const TermsAndConditions = () => {

    let parsed = marked(termsMarkdown);

    useEffect(() => {
        document.title = "Terms and Conditions";
    }, []);

    return html`
    <${BasicPageLayout} title="Terms and Conditions">
        <div dangerouslySetInnerHTML=${{__html: parsed}}></div>
    </div>
    `;
}

export default TermsAndConditions;