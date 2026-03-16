// ============================================================
// CHERNARUS MAP DATA
// Auto-extracted from Enfusion Workbench terrain entities
// Terrain bounds: 0,0 to 15360,15360 (15.36km x 15.36km)
//
// To add new markers, just add entries to the MAP_MARKERS array:
// { name: "Name", type: "town", x: 1234, z: 5678, y: 100, description: "Optional" }
//
// Types: city, town, village, military, quest, landmark, road
// ============================================================

const MAP_MARKERS = [
    // === CITIES (large settlements) ===
    {
        name: "Chernogorsk",
        type: "city",
        x: 6717.95,
        z: 2568,
        y: 10.8,
        description: "Major coastal city on the southern shore. Dense urban area with industrial zones."
    },
    {
        name: "Elektrozavodsk",
        type: "city",
        x: 10366.9,
        z: 2062.97,
        y: 5.8,
        description: "Eastern coastal city. Power plant and industrial district."
    },
    {
        name: "Berezino",
        type: "city",
        x: 12545.6,
        z: 9591.6,
        y: 5.7,
        description: "Major port city on the northeast coast."
    },

    // === TOWNS (medium settlements) ===
    {
        name: "Zelenogorsk",
        type: "town",
        x: 2721.69,
        z: 5310.02,
        y: 197.8,
        description: "Western inland town. Key crossroads."
    },
    {
        name: "Stary Sobor",
        type: "town",
        x: 6174.46,
        z: 7753.75,
        y: 292.4,
        description: "Central highland town near the old church."
    },
    {
        name: "Novy Sobor",
        type: "town",
        x: 7160.78,
        z: 7684.32,
        y: 285.5,
        description: "Central town east of Stary Sobor."
    },
    {
        name: "Gorka",
        type: "town",
        x: 9596.45,
        z: 8857.44,
        y: 292.2,
        description: "Eastern highland town."
    },
    {
        name: "Solnichniy",
        type: "town",
        x: 13397.6,
        z: 6355.46,
        y: 5.7,
        description: "Coastal town on the eastern shore. Quarry nearby."
    },
    {
        name: "Vybor",
        type: "town",
        x: 3799.81,
        z: 8860.27,
        y: 309.6,
        description: "Northwestern town near the airfield."
    },
    {
        name: "Lopatino",
        type: "town",
        x: 2657.95,
        z: 10133.6,
        y: 268.1,
        description: "Remote northwest settlement."
    },

    // === VILLAGES (small settlements) ===
    {
        name: "Kamenka",
        type: "village",
        x: 1789.96,
        z: 2153.75,
        y: 5.8,
        description: "Small southwestern coastal village. Common spawn area."
    },
    {
        name: "Balota",
        type: "village",
        x: 4577.74,
        z: 2468.68,
        y: 7.5,
        description: "Southern coastal village with a small airstrip nearby."
    },
    {
        name: "Komarovo",
        type: "village",
        x: 3612.25,
        z: 2412.94,
        y: 6.3,
        description: "Small southern coastal settlement."
    },
    {
        name: "Pavlovo",
        type: "village",
        x: 1718.65,
        z: 3704.17,
        y: 158.3,
        description: "Southwestern inland village. Military base nearby."
    },
    {
        name: "Kozlovka",
        type: "village",
        x: 4408.71,
        z: 4604.85,
        y: 225.8,
        description: "Inland village between Zelenogorsk and Chernogorsk."
    },
    {
        name: "Mogilevka",
        type: "village",
        x: 7589.71,
        z: 5155.73,
        y: 208.5,
        description: "Central southern village."
    },
    {
        name: "Vyshnoye",
        type: "village",
        x: 6549.5,
        z: 6067.84,
        y: 309.7,
        description: "Central village on the highland road."
    },
    {
        name: "Guglovo",
        type: "village",
        x: 8426.94,
        z: 6684.55,
        y: 348.4,
        description: "Small settlement in the central highlands."
    },
    {
        name: "Pusta",
        type: "village",
        x: 9147.76,
        z: 3891.07,
        y: 215.6,
        description: "Small village in the southeastern hills."
    },
    {
        name: "Polana",
        type: "village",
        x: 10687.8,
        z: 8024.75,
        y: 205.1,
        description: "Eastern village on the road to Berezino."
    },
    {
        name: "Dubrovka",
        type: "village",
        x: 10412.9,
        z: 9817.3,
        y: 118.7,
        description: "Northeastern village."
    },
    {
        name: "Staroye",
        type: "village",
        x: 10147.1,
        z: 5522.45,
        y: 236.5,
        description: "Eastern hillside village."
    },
    {
        name: "Msta",
        type: "village",
        x: 11272.5,
        z: 5453.6,
        y: 244.0,
        description: "Small eastern settlement."
    },
    {
        name: "Kamyshovo",
        type: "village",
        x: 12065.1,
        z: 3487.53,
        y: 5.8,
        description: "Southeastern coastal village."
    },
    {
        name: "Tulga",
        type: "village",
        x: 12880.3,
        z: 4461.48,
        y: 169.7,
        description: "Hillside village on the eastern coast."
    },
    {
        name: "Myshkino",
        type: "village",
        x: 1961.17,
        z: 7381.87,
        y: 247.0,
        description: "Remote western village."
    },
    {
        name: "Kabanino",
        type: "village",
        x: 5325.47,
        z: 8554.31,
        y: 324.4,
        description: "Highland village west of Stary Sobor."
    },

    // === MILITARY ===
    {
        name: "NWAF (Northwest Airfield)",
        type: "military",
        x: 4673.56,
        z: 10083.1,
        y: 327.4,
        description: "Major military airfield. High-tier loot. Heavily contested."
    },
    {
        name: "NWAF Bunker",
        type: "military",
        x: 3792.32,
        z: 11082.4,
        y: 323.3,
        description: "Underground bunker complex at the northwest airfield."
    },

    // === LANDMARK ===
    {
        name: "Elektro Lighthouse",
        type: "landmark",
        x: 11166.2,
        z: 2499.32,
        y: 39.6,
        description: "Lighthouse east of Elektrozavodsk."
    }
];
