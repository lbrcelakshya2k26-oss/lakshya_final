const express = require('express');
const router = express.Router();
const faqList = require('./faqData'); 
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
// ADDED: QueryCommand is needed to search by email
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

// --- AWS SETUP ---
const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'AKIAT4YSUMZD755UHGW7',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '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'
    }
});
const docClient = DynamoDBDocumentClient.from(client);

// --- MAIN CHAT ROUTE ---
router.post('/', async (req, res) => {
    const { message } = req.body;
    // ACCESS USER SESSION (Passed from backend.js)
    const user = req.session ? req.session.user : null;

    if (!message) {
        return res.json({ reply: "I didn't catch that.", actions: [] });
    }

    const msg = message.toLowerCase();
    let reply = "I'm not sure. Try asking about events, accommodation, or certificates.";
    let actions = [];

    try {
        // 1. CHECK STATIC FAQ FILE
        const foundFaq = faqList.find(item => 
            item.keywords.some(keyword => msg.includes(keyword))
        );

        if (foundFaq) {
            reply = foundFaq.answer;
            if (foundFaq.action) actions.push(foundFaq.action);
        }

        // 2. CHECK REGISTRATION STATUS (New Feature)
        else if (msg.includes('status') || msg.includes('registration') || msg.includes('my reg')) {
            if (!user) {
                reply = "You need to be logged in to check your registration status.";
                actions = [{ text: "Login Now", link: "/login" }];
            } else {
                // Query Database for this student
                const params = {
                    TableName: 'Lakshya_Registrations',
                    IndexName: 'StudentIndex',
                    KeyConditionExpression: 'studentEmail = :email',
                    ExpressionAttributeValues: { ':email': user.email }
                };
                const data = await docClient.send(new QueryCommand(params));
                const regs = data.Items || [];

                if (regs.length === 0) {
                    reply = `Hi ${user.name || 'there'}, I don't see any registrations for you yet.`;
                    actions = [{ text: "Browse Events", link: "/events" }];
                } else {
                    const paidCount = regs.filter(r => r.paymentStatus === 'COMPLETED').length;
                    const pendingCount = regs.length - paidCount;
                    
                    reply = `You have registered for ${regs.length} event(s). (${paidCount} Paid, ${pendingCount} Pending).`;
                    actions = [{ text: "View Dashboard", link: "/participant/dashboard" }];
                }
            }
        }

        // 3. CHECK EVENT COUNTS
        else if (msg.includes('event') || msg.includes('how many')) {
            const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
            const count = (data.Items || []).length;
            reply = `We have ${count} exciting events planned across different departments!`;
            actions = [{ text: "View Events", link: "/events" }];
        }

        res.json({ reply, actions });

    } catch (err) {
        console.error("Chat Error:", err);
        res.json({ 
            reply: "I'm having trouble connecting to the server. Please check your dashboard manually.", 
            actions: [{ text: "Go to Dashboard", link: "/participant/dashboard" }] 
        });
    }
});

module.exports = router;