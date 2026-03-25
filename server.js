const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Parser = require('rss-parser');
const dotenv = require('dotenv');
const cron = require('node-cron');

dotenv.config();

const app = express();

// Middleware
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true
}));
app.use(express.json());

// MongoDB Connection
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/trugydex';

mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Schemas
const circularSchema = new mongoose.Schema({
    circularId: { type: String, unique: true, sparse: true },
    circularNumber: String,
    title: String,
    description: String,
    content: String,
    regulatorCode: String,
    regulatorName: String,
    publishedDate: Date,
    sourceUrl: String,
    feedSource: String,
    status: { type: String, enum: ['active', 'pending', 'complied', 'archived'], default: 'active' },
    category: String,
    tags: [String],
    aiInterpretation: {
        summary: String,
        keyPoints: [String],
        impactArea: String,
        complianceDeadline: Date,
        audience: [String],
        generatedAt: Date
    },
    fetchedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const Circular = mongoose.model('Circular', circularSchema);

// Audit Log Schema
const auditSchema = new mongoose.Schema({
    action: String,
    circularsProcessed: Number,
    newCirculars: Number,
    updatedCirculars: Number,
    failedFeeds: [String],
    timestamp: { type: Date, default: Date.now },
    duration: Number
});

const Audit = mongoose.model('Audit', auditSchema);

// RSS Feed Configuration
const RSS_FEEDS = {
    NSE: [
        'https://nsearchives.nseindia.com/content/RSS/Circulars.xml'
    ],
    BSE: [
        'https://www.bseindia.com/data/xml/notices.xml'
    ],
    MCX: [
        'https://www.mcxindia.com/en/rssfeed/circulars/membership-and-compliance'
    ],
    NCDEX: [
        'https://www.ncdex.com/rss/news.rss'
    ],
    SEBI: [
        'https://www.sebi.gov.in/rss/news.rss',
        'https://www.sebi.gov.in/rss/press.rss'
    ],
    APMI: [
        'https://www.apmiindia.com/rss/news.rss'
    ]
};

const parser = new Parser({
    customFields: {
        item: [
            ['content:encoded', 'fullContent'],
            ['description', 'description']
        ]
    }
});

// Utility Functions
async function parseFeed(url, regulatorCode, regulatorName) {
    try {
        const feed = await parser.parseURL(url);
        const circulars = [];

        for (const item of feed.items) {
            const circularData = {
                circularNumber: extractCircularNumber(item.title),
                title: item.title,
                description: item.content || item.description || item.summary,
                content: item.fullContent || item.description || '',
                regulatorCode,
                regulatorName,
                publishedDate: new Date(item.pubDate || item.isoDate),
                sourceUrl: item.link,
                feedSource: url,
                category: categorizeCircular(item.title),
                tags: extractTags(item.title),
                status: 'active'
            };

            // Create unique ID from regulator + number + date
            const dateStr = new Date(circularData.publishedDate).toISOString().split('T')[0];
            circularData.circularId = `${regulatorCode}-${circularData.circularNumber || 'UNKNOWN'}-${dateStr}`;

            circulars.push(circularData);
        }

        return circulars;
    } catch (error) {
        console.error(`❌ Error parsing ${regulatorCode} feed ${url}:`, error.message);
        return [];
    }
}

function extractCircularNumber(title) {
    const match = title.match(/(?:Circular|Notice|Order)?[:\s]+([A-Z0-9/-]+)/i);
    return match ? match[1].trim() : null;
}

function categorizeCircular(title) {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes('trading') || lowerTitle.includes('member')) return 'Trading';
    if (lowerTitle.includes('compliance') || lowerTitle.includes('requirement')) return 'Compliance';
    if (lowerTitle.includes('risk') || lowerTitle.includes('margin')) return 'Risk Management';
    if (lowerTitle.includes('settlement') || lowerTitle.includes('clearing')) return 'Settlement';
    if (lowerTitle.includes('listing') || lowerTitle.includes('ipo')) return 'Listing';
    return 'General';
}

function extractTags(title) {
    const tags = [];
    if (title.match(/compliance|requirement|mandatory/i)) tags.push('Compliance');
    if (title.match(/risk|margin|exposure/i)) tags.push('RiskMgmt');
    if (title.match(/trading|market|order/i)) tags.push('Trading');
    if (title.match(/settlement|clearing|payment/i)) tags.push('Settlement');
    if (title.match(/listing|ipo|fundraising/i)) tags.push('Capital Markets');
    if (title.match(/emergency|urgent|immediate/i)) tags.push('Urgent');
    return tags;
}

// API Routes

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// Get all circulars with pagination and filtering
app.get('/api/v1/circulars/all', async (req, res) => {
    try {
        const { 
            limit = 100, 
            page = 1, 
            regulator = null,
            status = null,
            sortBy = 'publishedDate'
        } = req.query;

        const skip = (page - 1) * limit;
        let filter = {};

        if (regulator && regulator !== 'all') {
            filter.regulatorCode = regulator;
        }
        if (status && status !== 'all') {
            filter.status = status;
        }

        const total = await Circular.countDocuments(filter);
        const circulars = await Circular.find(filter)
            .sort({ [sortBy]: -1 })
            .limit(parseInt(limit))
            .skip(skip);

        res.json({
            status: 'success',
            data: {
                circulars,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / limit)
                }
            }
        });
    } catch (error) {
        console.error('Error fetching circulars:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Get circulars by regulator
app.get('/api/v1/circulars/:regulator', async (req, res) => {
    try {
        const { regulator } = req.params;
        const { limit = 50, page = 1 } = req.query;

        const skip = (page - 1) * limit;
        const total = await Circular.countDocuments({ regulatorCode: regulator });
        const circulars = await Circular.find({ regulatorCode: regulator })
            .sort({ publishedDate: -1 })
            .limit(parseInt(limit))
            .skip(skip);

        res.json({
            status: 'success',
            data: {
                regulator,
                circulars,
                pagination: { total, page: parseInt(page), limit: parseInt(limit) }
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Get single circular
app.get('/api/v1/circulars/detail/:id', async (req, res) => {
    try {
        const circular = await Circular.findById(req.params.id);
        if (!circular) {
            return res.status(404).json({ status: 'error', message: 'Circular not found' });
        }
        res.json({ status: 'success', data: { circular } });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Get stats
app.get('/api/v1/stats', async (req, res) => {
    try {
        const stats = {
            total: await Circular.countDocuments(),
            active: await Circular.countDocuments({ status: 'active' }),
            complied: await Circular.countDocuments({ status: 'complied' }),
            archived: await Circular.countDocuments({ status: 'archived' }),
            byRegulator: {}
        };

        // Count by regulator
        const regulators = await Circular.distinct('regulatorCode');
        for (const reg of regulators) {
            stats.byRegulator[reg] = await Circular.countDocuments({ regulatorCode: reg });
        }

        // Recent circulars
        stats.recentCount = await Circular.countDocuments({
            publishedDate: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        });

        res.json({ status: 'success', data: stats });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Fetch and update circulars from RSS
app.post('/api/v1/fetch/update', async (req, res) => {
    const startTime = Date.now();
    const auditLog = {
        action: 'RSS_FETCH_UPDATE',
        circularsProcessed: 0,
        newCirculars: 0,
        updatedCirculars: 0,
        failedFeeds: []
    };

    try {
        let allCirculars = [];

        // Fetch from all feeds
        for (const [regulatorCode, urls] of Object.entries(RSS_FEEDS)) {
            for (const url of urls) {
                const circulars = await parseFeed(url, regulatorCode, getRegulatorName(regulatorCode));
                allCirculars = allCirculars.concat(circulars);
            }
        }

        auditLog.circularsProcessed = allCirculars.length;

        // Upsert circulars into MongoDB
        for (const circularData of allCirculars) {
            try {
                const result = await Circular.findOneAndUpdate(
                    { circularId: circularData.circularId },
                    circularData,
                    { upsert: true, new: true }
                );

                if (result.isNew) {
                    auditLog.newCirculars++;
                } else {
                    auditLog.updatedCirculars++;
                }
            } catch (error) {
                console.error('Error upserting circular:', error);
            }
        }

        auditLog.duration = Date.now() - startTime;

        // Log audit
        await Audit.create(auditLog);

        res.json({
            status: 'success',
            message: `Processed ${allCirculars.length} circulars (${auditLog.newCirculars} new, ${auditLog.updatedCirculars} updated)`,
            data: auditLog
        });
    } catch (error) {
        console.error('Error updating circulars:', error);
        auditLog.duration = Date.now() - startTime;
        await Audit.create(auditLog);
        res.status(500).json({ status: 'error', message: error.message, data: auditLog });
    }
});

// AI Interpretation (placeholder - integrate with Claude API)
app.post('/api/v1/interpret', async (req, res) => {
    try {
        const { circular_id, interpretation_type = 'summary', audience = 'broker' } = req.body;

        const circular = await Circular.findById(circular_id);
        if (!circular) {
            return res.status(404).json({ status: 'error', message: 'Circular not found' });
        }

        // TODO: Integrate with Claude API for AI interpretation
        const interpretation = {
            summary: circular.description,
            keyPoints: circular.tags,
            impactArea: circular.category,
            audience: [audience],
            generatedAt: new Date()
        };

        res.json({
            status: 'success',
            data: { interpretation }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Get audit logs
app.get('/api/v1/audit/logs', async (req, res) => {
    try {
        const { limit = 50, page = 1 } = req.query;
        const skip = (page - 1) * limit;

        const logs = await Audit.find()
            .sort({ timestamp: -1 })
            .limit(parseInt(limit))
            .skip(skip);

        res.json({
            status: 'success',
            data: { logs }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Update circular status
app.patch('/api/v1/circulars/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const circular = await Circular.findByIdAndUpdate(
            req.params.id,
            { status, updatedAt: new Date() },
            { new: true }
        );

        res.json({ status: 'success', data: { circular } });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Helper function
function getRegulatorName(code) {
    const names = {
        NSE: 'National Stock Exchange',
        BSE: 'Bombay Stock Exchange',
        MCX: 'Multi Commodity Exchange',
        NCDEX: 'National Agricultural Exchange',
        SEBI: 'Securities & Exchange Board of India',
        APMI: 'Association of Portfolio Managers'
    };
    return names[code] || code;
}

// Scheduled RSS fetch (every 4 hours)
cron.schedule('0 */4 * * *', async () => {
    console.log('🔄 Running scheduled RSS fetch...');
    const startTime = Date.now();

    try {
        let allCirculars = [];
        for (const [regulatorCode, urls] of Object.entries(RSS_FEEDS)) {
            for (const url of urls) {
                const circulars = await parseFeed(url, regulatorCode, getRegulatorName(regulatorCode));
                allCirculars = allCirculars.concat(circulars);
            }
        }

        let newCount = 0, updatedCount = 0;
        for (const circularData of allCirculars) {
            const result = await Circular.findOneAndUpdate(
                { circularId: circularData.circularId },
                circularData,
                { upsert: true, new: true }
            );
            if (result.isNew) newCount++;
            else updatedCount++;
        }

        const duration = Date.now() - startTime;
        console.log(`✅ Scheduled fetch completed: ${newCount} new, ${updatedCount} updated (${duration}ms)`);

        await Audit.create({
            action: 'SCHEDULED_RSS_FETCH',
            circularsProcessed: allCirculars.length,
            newCirculars: newCount,
            updatedCirculars: updatedCount,
            duration
        });
    } catch (error) {
        console.error('❌ Scheduled fetch error:', error);
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ status: 'error', message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ status: 'error', message: err.message });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 MongoDB: ${mongoUri}`);
});
