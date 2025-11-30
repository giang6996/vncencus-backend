
const express = require('express');
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'vietcensus-dev-secret';

const router = express.Router();

// For demo
const VERBOSE = process.env.VERBOSE === 'true';

function vLog(...args) {
  if (VERBOSE) {
    console.log(...args);
  }
}

// Helper: convert "yes"/"no"/null -> boolean
function yesNoToBool(val) {
  if (val === 'yes') return true;
  if (val === 'no') return false;
  return null;
}

// Validate token & attach citizen info to req.citizenAuth
function authCitizen(req, res, next) {
  const authHeader = req.headers.authorization || '';


  vLog('authCitizen: incoming Authorization header =', authHeader);

  const [type, token] = authHeader.split(' ');

  if (type !== 'Bearer' || !token) {
    vLog('authCitizen: missing or invalid token format'); // For token auth demo
    return res.status(401).json({ error: 'Thiếu hoặc sai định dạng token.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    vLog('authCitizen: token decoded =', {
      citizenIdId: decoded.citizenIdId,
      citizenNumber: decoded.citizenNumber,
      sub: decoded.sub,
      role: decoded.role,
    });
    req.citizenAuth = decoded;   // contains citizenIdId, citizenNumber,...
    next();
  } catch (err) {
    console.error('Invalid citizen token', err);
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

// POST /api/census/submit
router.post('/submit', authCitizen, async (req, res) => {
  const client = await pool.connect();

  try {
    const { censusYear, household, members } = req.body;
    const { citizenIdId, citizenNumber } = req.citizenAuth;  
    const year = censusYear || new Date().getFullYear();

    vLog('/api/census/submit');
    vLog('Citizen:', { citizenIdId, citizenNumber });
    vLog('Census year:', year);
    vLog('Household payload (summary):', {
      provinceCode: household?.provinceCode,
      districtId: household?.districtId,
      wardId: household?.wardId,
    });
    vLog('Members count:', Array.isArray(members) ? members.length : 0);

    if (!household || !Array.isArray(members) || members.length === 0) {
      vLog('Validation failed: missing household or members');
      return res.status(400).json({ error: 'Invalid household or members data' });
    }

    await client.query('BEGIN');
    vLog('Transaction: BEGIN');

    vLog(
      'Checking existing submission for citizenIdId =',
      citizenIdId,
      'year =',
      year
    );

    // 0) Check if already submitted
    const existing = await client.query(
      `
      SELECT p.id
      FROM persons p
      WHERE p.citizen_id_id = $1
        AND p.census_year = $2
      LIMIT 1
      `,
      [citizenIdId, year]
    );
    vLog('Existing submission rowCount =', existing.rowCount);

    if (existing.rowCount > 0) {
      vLog('Duplicate submission detected');
      await client.query('ROLLBACK');
      vLog('Transaction: ROLLBACK');
      return res.status(409).json({ error: 'Bạn đã hoàn thành điều tra năm nay.' });
    }

    // 1) Insert household
    const householdCode = `HH-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    vLog('Inserting household with code =', householdCode);

    const insertHouseholdQuery = `
      INSERT INTO households (
        household_code,
        province_code,
        district_id,
        ward_id,
        address_detail,
        is_urban,
        housing_ownership, housing_type,
        main_wall_material, main_roof_material, main_floor_material,
        floor_area_m2, num_rooms,
        drinking_water_source, other_water_source,
        toilet_type, garbage_disposal,
        lighting_source, cooking_fuel,
        has_electricity, has_internet, has_tv, has_fridge, has_washing_machine,
        has_computer, has_car, has_motorcycle,
        census_year
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,
        $18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,
        $28
      )
      RETURNING id;
    `;

    const hhValues = [
      householdCode,
      household.provinceCode || null,
      household.districtId || null,
      household.wardId || null,
      household.addressDetail || null,
      household.isUrban,
      household.housingOwnership || null,
      household.housingType || null,
      household.mainWallMaterial || null,
      household.mainRoofMaterial || null,
      household.mainFloorMaterial || null,
      household.floorAreaM2 ? Number(household.floorAreaM2) : null,
      household.numRooms ? parseInt(household.numRooms, 10) : null,
      household.drinkingWaterSource || null,
      household.otherWaterSource || null,
      household.toiletType || null,
      household.garbageDisposal || null,
      household.lightingSource || null,
      household.cookingFuel || null,
      yesNoToBool(household.hasElectricity),
      yesNoToBool(household.hasInternet),
      yesNoToBool(household.hasTv),
      yesNoToBool(household.hasFridge),
      yesNoToBool(household.hasWashingMachine),
      yesNoToBool(household.hasComputer),
      yesNoToBool(household.hasCar),
      yesNoToBool(household.hasMotorcycle),
      year
    ];

    const hhRes = await client.query(insertHouseholdQuery, hhValues);
    const householdId = hhRes.rows[0].id;

    vLog('Inserting persons info...');

    // 2) Insert persons
    const insertPersonQuery = `
      INSERT INTO persons (
        household_id,
        citizen_id_id,
        full_name, sex, date_of_birth,
        relationship_to_head, ethnicity, religion,
        marital_status,
        ever_attended_school, currently_attending,
        highest_education_level, literacy,
        main_activity, employment_status, occupation, industry,
        migration_status,
        previous_province_code, previous_district_name,
        has_disability, disability_type,
        census_year,
        submission_date
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,
        $9,
        $10,$11,$12,$13,
        $14,$15,$16,$17,
        $18,$19,$20,
        $21,$22,$23,
        NOW()
      ) RETURNING id;
    `;

    for (const member of members) {
      const isHead = member.isHead === true;

      const personValues = [
        householdId,
        isHead ? citizenIdId : null,      
        member.fullName || null,
        member.sex || null,
        member.dateOfBirth || null,
        member.relationshipToHead || null,
        member.ethnicity || null,
        member.religion || null,
        member.maritalStatus || null,
        member.everAttendedSchool !== null ? !!member.everAttendedSchool : null,
        member.currentlyAttending !== null ? !!member.currentlyAttending : null,
        member.highestEducationLevel || null,
        member.literacy !== null ? !!member.literacy : null,
        member.mainActivity || null,
        member.employmentStatus || null,
        member.occupation || null,
        member.industry || null,
        member.migrationStatus || null,
        member.previousProvinceCode || null,
        member.previousDistrictName || null,
        member.hasDisability !== null ? !!member.hasDisability : null,
        Array.isArray(member.disabilityType) && member.disabilityType.length
          ? member.disabilityType
          : null,
        year
      ];

      await client.query(insertPersonQuery, personValues);
    }

    await client.query('COMMIT');

    vLog('Transaction: COMMIT');
    vLog('Census submit success:', householdId);

    return res.json({
      status: 'ok',
      householdId,
      personsInserted: members.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in /api/census/submit', err);
    vLog('Transaction: ROLLBACK due to error, oops!');
    return res.status(500).json({ error: 'Failed to save census data' });
  } finally {
    client.release();
  }
});

module.exports = router;
