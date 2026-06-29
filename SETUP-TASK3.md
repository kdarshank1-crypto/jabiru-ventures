\# Setup Required for invoice-generator (Task 3)



The `invoice-generator` Edge Function code is deployed in this repo, but

it will NOT work until the following two Supabase setup steps are done.



\---



\## 1. Create the `invoices` table



Go to: Supabase Dashboard → SQL Editor → New Query



Paste and run this SQL:



```sql

CREATE TABLE invoices (

&#x20; id uuid DEFAULT gen\_random\_uuid() PRIMARY KEY,

&#x20; job\_id uuid REFERENCES jobs(id),

&#x20; milestone text,

&#x20; amount decimal,

&#x20; invoice\_ref text,

&#x20; sent\_at timestamptz DEFAULT now()

);

```



This table logs every invoice sent (deposit / completion / final) per job.



\---



\## 2. Create a public Storage bucket called `invoices`



Go to: Supabase Dashboard → Storage → New bucket



\- Name: `invoices`

\- Public bucket: \*\*ON\*\* (must be public — WhatsApp Cloud API needs a public

&#x20; URL to fetch and send the PDF as a document attachment)



Without this, the PDF can still be emailed, but WhatsApp sending will fail.



\---



\## 3. After both steps above are done, deploy the function



From the project root (`jabiru-ventures` folder), run:



```bash

supabase functions deploy invoice-generator --no-verify-jwt

```



\---



\## How the invoice-generator function is triggered



It is called manually (e.g. via a button in the CRM dashboard) — NOT

automatically. Each button click sends one milestone invoice.



Endpoint:

```

POST https://oeuzdjsgpowjfiqkzdoz.supabase.co/functions/v1/invoice-generator

```



Body (JSON):

```json

{

&#x20; "job\_id": "uuid-of-the-job",

&#x20; "milestone": "deposit",

&#x20; "amount": 1500.00

}

```



`milestone` must be one of: `"deposit"`, `"completion"`, `"final"`



Milestone meanings:

\- `deposit`    -> Deposit Payment (50%) — required before work starts

\- `completion` -> Completion Payment (30%) — after inspection done

\- `final`      -> Final Payment (20%) — upon official report submission



Suggested CRM UI: 3 buttons per job — "Send Deposit Invoice",

"Send Completion Invoice", "Send Final Invoice" — each calling this

endpoint with the relevant milestone and the RM amount the owner enters.



\---



\## What the function does when called



1\. Fetches job, customer, and property details from Supabase

2\. Generates a branded PDF invoice (Jabiru navy/blue colours) showing

&#x20;  ONLY that milestone's amount

3\. Uploads the PDF to the `invoices` storage bucket

4\. Sends the PDF to the client via WhatsApp (as a file attachment)

5\. Emails the PDF to the client (sent from jscorp1305@gmail.com via

&#x20;  Gmail SMTP)

6\. Logs the invoice in the `invoices` table



\---



\## Secrets already set (no action needed)



These are already configured in Supabase secrets:

\- SB\_URL

\- SB\_SERVICE\_ROLE\_KEY

\- WHATSAPP\_TOKEN (currently placeholder — needs real value)

\- WHATSAPP\_PHONE\_NUMBER\_ID (currently placeholder — needs real value)

\- GMAIL\_APP\_PASSWORD

\- GMAIL\_SENDER\_EMAIL



Note: WhatsApp sending will not work until WHATSAPP\_TOKEN and

WHATSAPP\_PHONE\_NUMBER\_ID are updated with real values from Meta

Developer Portal (see main project notes for details).



