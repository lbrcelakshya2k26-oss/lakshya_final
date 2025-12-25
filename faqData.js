// faqData.js
module.exports = [
    {
        id: 'accommodation',
        keywords: ['accommodation', 'stay', 'room', 'hostel', 'living'],
        answer: "Accommodation is provided in the college hostels for ₹200/day per person. Separate blocks are available for boys and girls.",
        action: { text: "Contact Coordinator", link: "/contact" }
    },
    {
        id: 'certificates',
        keywords: ['certificate', 'participation', 'merit'],
        answer: "Certificates will be generated digitally and made available on your dashboard within 24 hours after the event concludes.",
        action: { text: "My Certificates", link: "/participant/certificates" }
    },
    {
        id: 'refund',
        keywords: ['refund', 'cancel', 'money back'],
        answer: "Registration fees are strictly non-refundable once paid, as per the event policy.",
        action: null
    },
    {
        id: 'location',
        keywords: ['location', 'where', 'map', 'venue', 'address'],
        answer: "LAKSHYA fest is conducted at Lakireddy Bali Reddy College of Engineering (LBRCE), Mylavaram. Events will be held near the Admin Block and respective departments.",
        action: { text: "View Map", link: "/contact" }
    },
    {
        id: 'food',
        keywords: ['food', 'lunch', 'canteen', 'dinner'],
        answer: "Food stalls will be available near major event venues, and the college canteen will operate throughout the fest.",
        action: null
    },

    /* =====================
       GENERAL QUESTIONS
       ===================== */

    {
        id: 'event_dates',
        keywords: ['date', 'when', 'schedule', 'day'],
        answer: "The complete event schedule, including dates and timings, is available on the official LAKSHYA website under the Events section.",
        action: { text: "View Schedule", link: "/events" }
    },
    {
        id: 'eligibility',
        keywords: ['who can participate', 'eligibility', 'students', 'college'],
        answer: "Students from all colleges and universities are eligible to participate in LAKSHYA events, unless specified otherwise for a particular event.",
        action: null
    },
    {
        id: 'team_size',
        keywords: ['team', 'members', 'team size'],
        answer: "Team size varies from event to event. Please check the specific event details page for exact team size requirements.",
        action: { text: "Event Details", link: "/events" }
    },
    {
        id: 'id_card',
        keywords: ['id card', 'identity', 'college id'],
        answer: "Participants must carry a valid college ID card or government-issued photo ID for entry and verification.",
        action: null
    },
    {
        id: 'reporting_time',
        keywords: ['reporting time', 'check-in', 'arrival'],
        answer: "Participants are advised to report at least 30 minutes before their scheduled event time for smooth coordination.",
        action: null
    },
    {
        id: 'help_desk',
        keywords: ['help desk', 'support', 'assistance'],
        answer: "A dedicated help desk will be available near the main entrance throughout the fest to assist participants.",
        action: null
    },

    /* =====================
       PAYMENT & SUPPORT
       ===================== */

    {
        id: 'payment_methods',
        keywords: ['payment methods', 'upi', 'card', 'net banking'],
        answer: "We accept payments via UPI, debit cards, credit cards, and net banking through a secure payment gateway.",
        action: null
    },
    {
        id: 'payment_failed',
        keywords: ['payment failed', 'transaction failed', 'amount deducted'],
        answer: "If your payment failed or the amount was deducted without successful registration, please contact support with your transaction ID.",
        action: { text: "Payment Support", link: "/participant/support" }

    },
    {
        id: 'receipt',
        keywords: ['receipt', 'invoice', 'payment proof'],
        answer: "Payment confirmation and receipt will be automatically sent to your registered email after successful registration.",
        action: null
    },
    {
        id: 'support_contact',
        keywords: ['support', 'contact support', 'help payment'],
        answer: "For any technical, payment, or registration-related queries, please reach out to our support team.",
        action: { text: "Contact Support", link: "/support" }
    }
];
