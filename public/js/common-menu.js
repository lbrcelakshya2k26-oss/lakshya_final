/**
 * MODERN COMMON MENU GENERATOR
 * Enhanced Dark UI with scoped classes to prevent style overriding.
 */

const menuItems = [
    { label: 'Analytics', icon: 'fa-chart-pie', link: 'dashboard' },
    { label: 'Registrations', icon: 'fa-users', link: 'registrations' },
    { label: 'On-Site Reg', icon: 'fa-cash-register', link: 'register-participant' },
    { label: 'On-Site Reports', icon: 'fa-chart-column', link: 'onsite-reports' },
    { label: 'Attendance', icon: 'fa-clipboard-user', link: 'attendance' },
    { label: 'Payments', icon: 'fa-money-bill-wave', link: 'payment-status' },
    { label: 'Assign Score', icon: 'fa-pen-to-square', link: 'assign-score' },
    { label: 'Add Team', icon: 'fa-pen-to-square', link: 'add-team' },
    { label: 'View Submissions', icon: 'fa-pen-to-square', link: 'view-submissions' },
    { label: 'Issue Kits', icon: 'fa-box-open', link: 'benficiaries' },
];

document.addEventListener('DOMContentLoaded', () => {
    // 1. Inject Modern Dark Styles with scoped selectors
    const style = document.createElement('style');
    style.innerHTML = `
        :root {
            --sb-bg: #111827;
            --sb-text: #94a3b8;
            --sb-active-bg: #6366f1;
            --sb-active-text: #ffffff;
            --sb-hover-bg: rgba(255, 255, 255, 0.05);
            --sb-border: rgba(255, 255, 255, 0.1);
            --sb-width: 280px;
            --sb-transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Prevent sidebar from overriding page content layout on desktop */
        @media (min-width: 769px) {
            body {
                padding-left: var(--sb-width);
            }
        }

        .custom-sidebar {
            width: var(--sb-width);
            height: 100vh;
            background: var(--sb-bg);
            border-right: 1px solid var(--sb-border);
            position: fixed;
            left: 0;
            top: 0;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            transition: var(--sb-transition);
            color: var(--sb-text);
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
        }

        .custom-sidebar .sidebar-logo {
            padding: 32px 24px;
            font-size: 1.25rem;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: 0.05em;
            display: flex;
            justify-content: space-between;
            align-items: center;
            text-transform: uppercase;
        }

        .close-sidebar-btn {
            display: none;
            cursor: pointer;
            padding: 8px;
            color: var(--sb-text);
            transition: var(--sb-transition);
        }

        .close-sidebar-btn:hover { color: #fff; }

        .custom-sidebar .sidebar-nav-menu {
            list-style: none !important;
            padding: 0 16px !important;
            margin: 0 !important;
            flex-grow: 1;
            overflow-y: auto;
        }

        /* Custom Scrollbar */
        .custom-sidebar .sidebar-nav-menu::-webkit-scrollbar { width: 4px; }
        .custom-sidebar .sidebar-nav-menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }

        .custom-sidebar .sidebar-nav-menu li { 
            margin-bottom: 4px !important; 
            list-style: none !important;
        }

        .custom-sidebar .sidebar-nav-menu a {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 12px 16px;
            text-decoration: none !important;
            color: var(--sb-text) !important;
            font-size: 0.9rem;
            font-weight: 500;
            border-radius: 10px;
            transition: var(--sb-transition);
            cursor: pointer;
        }

        .custom-sidebar .sidebar-nav-menu a i {
            width: 20px;
            text-align: center;
            font-size: 1.1rem;
            transition: var(--sb-transition);
        }

        .custom-sidebar .sidebar-nav-menu a:hover {
            background: var(--sb-hover-bg);
            color: #ffffff !important;
        }

        .custom-sidebar .sidebar-nav-menu a.active {
            background: var(--sb-active-bg) !important;
            color: var(--sb-active-text) !important;
            box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.3);
        }

        .custom-sidebar .sidebar-nav-menu a.active i { color: #ffffff !important; }

        .sidebar-footer {
            margin-top: auto;
            padding: 16px;
            border-top: 1px solid var(--sb-border);
        }

        .sidebar-nav-menu .logout-link {
            color: #f87171 !important;
        }

        .sidebar-nav-menu .logout-link:hover {
            background: rgba(248, 113, 113, 0.1) !important;
            color: #f87171 !important;
        }

        .sidebar-blur-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(8px);
            opacity: 0;
            pointer-events: none;
            transition: var(--sb-transition);
            z-index: 9998;
        }

        /* Mobile Adjustments */
        @media (max-width: 768px) {
            body { padding-left: 0; }
            .custom-sidebar { transform: translateX(-100%); width: 280px; }
            .custom-sidebar.active { transform: translateX(0); }
            .sidebar-blur-overlay.active { opacity: 1; pointer-events: auto; }
            .close-sidebar-btn { display: block; }
        }
    `;
    document.head.appendChild(style);

    // 2. Generate Overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-blur-overlay';
    overlay.id = 'sidebarOverlay';
    overlay.onclick = toggleSidebar;
    document.body.appendChild(overlay);

    // 3. Generate Sidebar
    const aside = document.createElement('aside');
    aside.className = 'custom-sidebar';
    aside.id = 'sidebar';

    // Logo Section
    const logoDiv = document.createElement('div');
    logoDiv.className = 'sidebar-logo';
    logoDiv.innerHTML = `
        <span>DEPT COORD</span>
        <i class="fa-solid fa-xmark close-sidebar-btn" onclick="toggleSidebar()"></i>
    `;
    aside.appendChild(logoDiv);

    // Menu List
    const ul = document.createElement('ul');
    ul.className = 'sidebar-nav-menu';

    const currentPath = window.location.pathname;

    menuItems.forEach(item => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = item.link;
        a.innerHTML = `<i class="fa-solid ${item.icon}"></i> <span>${item.label}</span>`;

        if (currentPath.endsWith(item.link) || currentPath.includes('/' + item.link)) {
            a.classList.add('active');
        }

        li.appendChild(a);
        ul.appendChild(li);
    });

    // Logout
    const logoutLi = document.createElement('li');
    logoutLi.style.marginTop = '20px';
    logoutLi.style.borderTop = '1px solid var(--sb-border)';
    logoutLi.style.paddingTop = '10px';
    logoutLi.innerHTML = `
        <a onclick="logout()" class="logout-link">
            <i class="fa-solid fa-right-from-bracket"></i> 
            <span>Logout</span>
        </a>
    `;
    ul.appendChild(logoutLi);

    aside.appendChild(ul);
    document.body.prepend(aside);
});

window.toggleSidebar = function () {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar && overlay) {
        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
    }
};

window.logout = function () {
    if (confirm("Are you sure you want to logout?")) {
        localStorage.clear();
        window.location.href = '../login';
    }
};
