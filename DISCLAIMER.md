# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-commission-clawback-churn-reconciliation-calculator**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. That includes incorrect, duplicated, missed or disputed commission clawbacks; overpayments or underpayments to employees; payroll, tax or accounting errors; incorrect currency conversions; wrongly stamped or overwritten HubSpot records; disclosure of compensation data; and any employment, contractual or regulatory claim arising from an automated calculation.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, formulas and sample payloads are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Nothing here guarantees that a calculation matches your commission plan, that churn is detected completely, or that HubSpot APIs, limits and properties will stay unchanged.

**Not Financial, Legal or Payroll Advice:** This software does not interpret your commission plan, employment contracts or local wage law. Many jurisdictions restrict when and how earned commission may be recovered or deducted from wages. Whether a clawback is lawful, how it must be communicated, and how it is processed (deduction, repayment or offset against future commission) are decisions for your finance, legal and HR teams, not this workflow.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot credentials or enable `CSV_EXPORT_ENABLED` and `HUBSPOT_MUTATIONS_ENABLED`. Reconcile the DRAFT output against your commission ledger for at least one full period. Treat every payroll and audit file as a draft that a qualified person must review and approve before it reaches payroll or is relied on.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), employment and wage laws, and security policies of HubSpot, your payroll provider, n8n, and any connected services. That includes restricting access to compensation data and exported files, storing exports only in approved locations with appropriate retention, keeping FX rates and commission records accurate and approved, informing affected employees as your policies and local law require, and reviewing every automatically created file and updated record.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
