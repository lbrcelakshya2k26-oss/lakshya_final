/**
 * COMMON MENU GENERATOR
 * This script generates the sidebar and overlay dynamically.
 * It also handles the 'active' state based on the current URL.
 */

// 1. Define your menu items here
const menuItems = [
    { label: 'Analytics', icon: 'fa-chart-pie', link: 'dashboard' },
    { label: 'Registrations', icon: 'fa-users', link: 'registrations' },
    { label: 'Attendance', icon: 'fa-clipboard-user', link: 'attendance' },
    { label: 'Payments', icon: 'fa-money-bill-wave', link: 'payment-status' },
    { label: 'Assign Score', icon: 'fa-pen-to-square', link: 'assign-score' },
    { label: 'Add Team', icon: 'fa-pen-to-square', link: 'add-team' },
    { label: 'View Submissions', icon: 'fa-pen-to-square', link: 'view-submissions' },
    { label: 'Issue Kits', icon: 'fa-pen-to-square', link: 'benficiaries' },
];

document.addEventListener('DOMContentLoaded', () => {

    // A. Generate Sidebar Overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebarOverlay';
    overlay.onclick = toggleSidebar;
    document.body.appendChild(overlay);

    // B. Generate Sidebar
    const aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.id = 'sidebar';

    // 1. Logo Section
    const logoDiv = document.createElement('div');
    logoDiv.className = 'logo';
    logoDiv.innerHTML = `DEPT COORD <i class="fa-solid fa-xmark close-sidebar-btn" onclick="toggleSidebar()"></i>`;
    aside.appendChild(logoDiv);

    // 2. Menu Items
    const ul = document.createElement('ul');
    ul.className = 'menu';

    const currentPath = window.location.pathname;

    menuItems.forEach(item => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = item.link;

        a.innerHTML = `<i class="fa-solid ${item.icon}"></i> ${item.label}`;

        if (currentPath.includes(item.link)) {
            a.classList.add('active');
        }

        li.appendChild(a);
        ul.appendChild(li);
    });

    // 3. Logout Button
    const logoutLi = document.createElement('li');
    logoutLi.innerHTML = `<a onclick="logout()" class="logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>`;
    ul.appendChild(logoutLi);

    aside.appendChild(ul);

    // C. Inject Sidebar
    document.body.prepend(aside);
});

// Toggle Sidebar
window.toggleSidebar = function () {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('active');
    overlay.classList.toggle('active');
};

// Logout Handler
window.logout = function () {
    localStorage.clear();
    window.location.href = '../login';
};