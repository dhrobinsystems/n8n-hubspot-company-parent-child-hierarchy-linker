# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-company-parent-child-hierarchy-linker`) are provided strictly for educational and architectural reference purposes. I publish them to show how I design hierarchy automation for HubSpot. They are not a managed product, a supported service, or professional advice for your specific CRM.

## 1. No Warranty

All software, n8n JSON blueprints (`workflow.json`), JavaScript modules (`src/`), scripts (`scripts/`), tests, fixtures, and documentation are provided **"AS IS" and "AS AVAILABLE", without warranty of any kind**, express or implied, including but not limited to the implied warranties of merchantability, fitness for a particular purpose, accuracy, title, and non-infringement. I make no warranty that the code is error-free, that it will run without interruption, that it is compatible with any particular version of n8n or the HubSpot APIs, or that any defect will be corrected.

## 2. No Liability

To the maximum extent permitted by applicable law, neither **DH Robin** nor **dhRobin Systems** shall be liable for any direct, indirect, incidental, special, exemplary, consequential, or operational damages of any kind arising from the use, misuse, inability to use, or deployment of this automation, however caused and under any theory of liability (contract, strict liability, or tort, including negligence), even if advised of the possibility of such damages. This includes, without limitation:

- **CRM data corruption**, including overwritten, incorrect, or lost company properties and hierarchy metadata.
- **Broken, missing, duplicated, or incorrect company associations**, including wrong parent-child links, orphaned subsidiaries, or circular structures created outside the guards in this code.
- **Inaccurate ARR, revenue, or deal-value rollups**, and any business, forecasting, compensation, board, investor, or financial-reporting decision made from them.
- **Infinite or runaway webhook loops**, duplicate executions, and the n8n or HubSpot resource usage they cause.
- **API rate-limit exhaustion**, throttling, or suspension of HubSpot or other API access for your portal or app.
- **Third-party enrichment billing overages**, including Clearbit, Apollo, Dun & Bradstreet, or other data provider credits, seats, or usage charges.
- Loss of revenue, profits, data, goodwill, or business opportunity, and costs of procuring substitute services or of restoring data.

## 3. Production Testing Required

You assume full responsibility for validating all logic before any production deployment. At a minimum:

- Test thoroughly in an isolated staging environment, such as a **HubSpot developer test account or sandbox portal**, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before connecting live HubSpot credentials.
- Review the audit log output for a representative sample of companies before setting `DRY_RUN=false`.
- Take a full export or backup of company records and associations before the first live run.
- Treat every association change and every property overwrite as potentially irreversible at scale.
- Keep the workflow `active: false` until you have reviewed every node, credential, and environment variable.

## 4. Third-Party APIs & Compliance

You are solely responsible for complying with the terms of service, acceptable-use policies, rate limits, and security requirements of HubSpot, n8n, and every enrichment or data provider you connect. You are also solely responsible for ensuring full compliance with applicable data privacy and protection laws, including the **EU/UK General Data Protection Regulation (GDPR)** and the **California Consumer Privacy Act (CCPA/CPRA)**. That includes establishing a lawful basis for processing, honouring data-subject requests, documenting processors and sub-processors, and confirming that any third-party metadata used to infer corporate relationships may lawfully be stored and processed in your CRM.

## 5. No Professional Advice and No Affiliation

Nothing in this repository is legal, financial, accounting, tax, or compliance advice. Rolled-up ARR and deal values are operational estimates, not audited figures. HubSpot, n8n, Clearbit, Apollo, and Dun & Bradstreet are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by, or sponsored by any of them.

## 6. Acceptance

By cloning, copying, importing, modifying, or deploying any part of this repository, you acknowledge that you have read this disclaimer, understand the operational risks, and accept full responsibility for any outcome. If you do not accept these terms, do not use this repository.

This disclaimer supplements, and does not replace, the MIT License in [LICENSE](LICENSE). Where the two overlap, the broader limitation of liability applies.

---

DH Robin · dhRobin Systems · [dhrobinsystems.com](https://dhrobinsystems.com) · robin@dhrobinsystems.com
