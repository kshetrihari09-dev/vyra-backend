-- Rebrand: "Vyra" -> "Vaspoor" in the NAMES shown to people (store, branches, the first-party shop, the demo admin).
-- Ids, emails and other identifiers are deliberately unchanged ('vyra-retail', 'store-01', admin@vyra.example …) so nothing that
-- refers to them (orders, saved addresses, logins) is affected. Old migrations are not edited: applied files are checksummed.
UPDATE stores   SET name = replace(name, 'Vyra', 'Vaspoor') WHERE name LIKE '%Vyra%';
UPDATE branches SET name = replace(name, 'Vyra', 'Vaspoor') WHERE name LIKE '%Vyra%';
UPDATE sellers  SET name = replace(name, 'Vyra', 'Vaspoor') WHERE name LIKE '%Vyra%';
UPDATE users    SET full_name = replace(full_name, 'Vyra', 'Vaspoor') WHERE email = 'admin@vyra.example' AND full_name LIKE '%Vyra%';
