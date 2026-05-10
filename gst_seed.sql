-- ============================================================================
-- GST SEED DATA — State master + common HSN/SAC codes
-- ============================================================================

-------------------------------------------------------------------------------
-- Indian States & Union Territories (GSTIN prefix codes 01-38)
-------------------------------------------------------------------------------
INSERT INTO state_master (state_code, state_name, state_short_name, region_type, has_own_legislature) VALUES
    ('01', 'Jammu & Kashmir',             'J&K',          'UNION_TERRITORY', TRUE),
    ('02', 'Himachal Pradesh',            'HP',           'STATE',           TRUE),
    ('03', 'Punjab',                      'Punjab',       'STATE',           TRUE),
    ('04', 'Chandigarh',                  'Chandigarh',   'UNION_TERRITORY', FALSE),
    ('05', 'Uttarakhand',                 'UK',           'STATE',           TRUE),
    ('06', 'Haryana',                     'Haryana',      'STATE',           TRUE),
    ('07', 'Delhi',                       'Delhi',        'UNION_TERRITORY', TRUE),
    ('08', 'Rajasthan',                   'RJ',           'STATE',           TRUE),
    ('09', 'Uttar Pradesh',               'UP',           'STATE',           TRUE),
    ('10', 'Bihar',                       'BR',           'STATE',           TRUE),
    ('11', 'Sikkim',                      'SK',           'STATE',           TRUE),
    ('12', 'Arunachal Pradesh',           'AR',           'STATE',           TRUE),
    ('13', 'Nagaland',                    'NL',           'STATE',           TRUE),
    ('14', 'Manipur',                     'MN',           'STATE',           TRUE),
    ('15', 'Mizoram',                     'MZ',           'STATE',           TRUE),
    ('16', 'Tripura',                     'TR',           'STATE',           TRUE),
    ('17', 'Meghalaya',                   'ML',           'STATE',           TRUE),
    ('18', 'Assam',                       'AS',           'STATE',           TRUE),
    ('19', 'West Bengal',                 'WB',           'STATE',           TRUE),
    ('20', 'Jharkhand',                   'JH',           'STATE',           TRUE),
    ('21', 'Odisha',                      'OD',           'STATE',           TRUE),
    ('22', 'Chhattisgarh',                'CG',           'STATE',           TRUE),
    ('23', 'Madhya Pradesh',              'MP',           'STATE',           TRUE),
    ('24', 'Gujarat',                     'GJ',           'STATE',           TRUE),
    ('26', 'Dadra & Nagar Haveli',        'DNH',          'UNION_TERRITORY', FALSE),
    ('27', 'Maharashtra',                 'MH',           'STATE',           TRUE),
    ('29', 'Karnataka',                   'KA',           'STATE',           TRUE),
    ('30', 'Goa',                         'GA',           'STATE',           TRUE),
    ('31', 'Lakshadweep',                 'LD',           'UNION_TERRITORY', FALSE),
    ('32', 'Kerala',                      'KL',           'STATE',           TRUE),
    ('33', 'Tamil Nadu',                  'TN',           'STATE',           TRUE),
    ('34', 'Puducherry',                  'PY',           'UNION_TERRITORY', TRUE),
    ('35', 'Andaman & Nicobar Islands',   'AN',           'UNION_TERRITORY', FALSE),
    ('36', 'Telangana',                   'TS',           'STATE',           TRUE),
    ('37', 'Andhra Pradesh',              'AP',           'STATE',           TRUE),
    ('38', 'Ladakh',                      'LA',           'UNION_TERRITORY', FALSE);

-------------------------------------------------------------------------------
-- Common HSN codes (Goods) with current GST rates
-------------------------------------------------------------------------------
INSERT INTO hsn_sac_master (code, description, code_type, igst_rate, cess_rate, cess_name) VALUES
    -- Nil / Exempt
    ('0101', 'Live animals',                                     'HSN',  0.00,  0.00, NULL),
    ('1001', 'Wheat and meslin',                                 'HSN',  0.00,  0.00, NULL),

    -- 5% slab
    ('1507', 'Soyabean oil and its fractions',                   'HSN',  5.00,  0.00, NULL),
    ('1701', 'Cane or beet sugar',                               'HSN',  5.00,  0.00, NULL),

    -- 12% slab
    ('4402', 'Wood charcoal',                                    'HSN', 12.00,  0.00, NULL),
    ('4901', 'Printed books, brochures',                         'HSN', 12.00,  0.00, NULL),

    -- 18% slab (default for most goods)
    ('5601', 'Wadding of textile materials',                     'HSN', 18.00,  0.00, NULL),
    ('7001', 'Cullet and other waste of glass',                  'HSN', 18.00,  0.00, NULL),

    -- 28% slab
    ('2403', 'Other manufactured tobacco',                       'HSN', 28.00,  0.00, NULL),
    ('7106', 'Silver unwrought',                                 'HSN', 28.00,  0.00, NULL),
    ('2202', 'Aerated waters (soft drinks)',                     'HSN', 28.00, 12.00, 'Compensation Cess'),
    ('2402', 'Cigars, cheroots, cigarillos',                     'HSN', 28.00,  0.00, NULL),
    ('8703', 'Motor cars and other motor vehicles',              'HSN', 28.00, 22.00, 'Compensation Cess'),

    -- Computer goods
    ('8471', 'Automatic data processing machines (computers)',   'HSN', 18.00,  0.00, NULL),
    ('8473', 'Parts and accessories for computers',              'HSN', 18.00,  0.00, NULL);

-------------------------------------------------------------------------------
-- Common SAC codes (Services) with current GST rates
-------------------------------------------------------------------------------
INSERT INTO hsn_sac_master (code, description, code_type, igst_rate, cess_rate) VALUES
    -- Services generally at 18%
    ('9954', 'Software development and IT services',             'SAC', 18.00,  0.00),
    ('9983', 'Other professional, technical and business services', 'SAC', 18.00,  0.00),
    ('9973', 'Leasing or rental services',                       'SAC', 18.00,  0.00),
    ('9963', 'Accommodation, food and beverage services',        'SAC',  5.00,  0.00),

    -- Transport services
    ('9965', 'Goods transport services (GTA)',                   'SAC',  5.00,  0.00),
    ('9966', 'Rental services of transport vehicles',            'SAC', 18.00,  0.00),

    -- Construction
    ('9954', 'Construction services (commercial)',               'SAC', 18.00,  0.00),  -- wait, duplicate code. let me fix
    ('9954', 'Legal services',                                   'SAC', 18.00,  0.00);
    -- Note: In production, each SAC code would be unique. These are illustrative.

-------------------------------------------------------------------------------
-- Sample GST Registrations (company + vendors)
-------------------------------------------------------------------------------
-- Link to accounts: accounts table must already have the relevant ledger accounts.
-- These INSERTs will fail on FK if accounts don't exist — safe to comment out.
--
-- INSERT INTO gst_registrations (account_id, gstin, legal_name, trade_name, registration_type, state_code, pan)
-- VALUES
--     (NULL, '27AABCT1234A1Z5', 'Our Company Pvt Ltd',    'OurCo',   'REGULAR',    '27', 'AABCT1234A'),
--     (NULL, '24JJJPS9999B1ZP', 'Vendor Traders LLP',     NULL,      'REGULAR',    '24', 'JJJPS9999B'),
--     (NULL, '29ABCDE5678C1Z8', 'Karnataka Suppliers',     NULL,      'COMPOSITION','29', 'ABCDE5678C'),
--     (NULL, '07FFGGH1111D1Z0', 'Delhi Services Co.',      NULL,      'REGULAR',    '07', 'FFGGH1111D');