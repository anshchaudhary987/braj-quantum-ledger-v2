-- ============================================================================
-- Seed Data — Sample COA & Balanced Transaction for Validation
-- ============================================================================

-- 1. Chart of Accounts (Assets -> Current Assets -> Bank Accounts -> SBI)
INSERT INTO accounts (account_id, parent_id, path, account_name, account_code, account_type)
VALUES
    (1,  NULL, '1',         'Assets',             '1000', 'Asset'),
    (2,  1,    '1.2',       'Current Assets',     '1100', 'Asset'),
    (3,  2,    '1.2.3',     'Bank Accounts',      '1110', 'Asset'),
    (4,  3,    '1.2.3.4',   'SBI Current A/c',    '1111', 'Asset'),

    (5,  NULL, '5',         'Liabilities',        '2000', 'Liability'),
    (6,  5,    '5.6',       'Current Liabilities','2100', 'Liability'),
    (7,  6,    '5.6.7',     'Accounts Payable',   '2110', 'Liability'),

    (8,  NULL, '8',         'Income',             '3000', 'Income'),
    (9,  8,    '8.9',       'Sales Revenue',      '3100', 'Income'),

    (10, NULL, '10',        'Expenses',           '4000', 'Expense'),
    (11, 10,   '10.11',     'Rent Expense',       '4100', 'Expense');

-- 2. Balanced Transaction (Debit Rent, Credit Bank)
INSERT INTO transactions (transaction_id, tenant_id, txn_date, description, metadata)
VALUES (1, '11111111-1111-1111-1111-111111111111'::uuid, '2026-05-07',
        'Office rent payment for May 2026',
        '{"voucher_type": "PAYMENT", "cheque_no": "CHQ-001"}'::jsonb);

INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
VALUES
    (1, 11, 25000.00, 0.00,     'Rent expense debited'),
    (1, 4,  0.00,     25000.00, 'Paid from SBI Current A/c');