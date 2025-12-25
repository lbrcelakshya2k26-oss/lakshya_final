document.addEventListener('DOMContentLoaded', function() {
    
    // --- 1. INJECT SIDEBAR CSS DYNAMICALLY ---
    const styleSheet = document.createElement("style");
    styleSheet.textContent = `
        /* --- SIDEBAR CONTAINER --- */
        .sidebar {
            box-sizing: border-box;          /* FIX: Ensures padding doesn't increase total height */
            width: 260px;
            height: 100vh;                   /* Fallback for older browsers */
            height: 100dvh;                  /* FIX: Adapts to mobile address bars so footer isn't cut off */
            position: fixed;
            top: 0;
            left: 0;
            background: rgba(10, 10, 18, 0.95); /* Deep dark background */
            backdrop-filter: blur(15px);        /* Glass effect */
            border-right: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            flex-direction: column;
            padding: 2rem 1.5rem;
            z-index: 10000;
            box-shadow: 5px 0 25px rgba(0, 0, 0, 0.5);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* --- LOGO STYLING (TEXT + SMALL IMAGE) --- */
        .sidebar .logo {
            margin-bottom: 2rem;
            cursor: pointer;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 12px; /* Space between logo and text */
            flex-shrink: 0; /* Prevent logo from shrinking */
        }

        .sidebar .logo img {
            height: 35px; /* Very small size as requested */
            width: auto;
            filter: drop-shadow(0 0 5px rgba(0, 210, 255, 0.6));
            transition: transform 0.3s ease;
        }

        .sidebar .logo span {
            font-family: 'Rajdhani', sans-serif;
            font-size: 1.8rem;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: 1px;
            text-shadow: 0 0 10px rgba(0, 210, 255, 0.5);
        }

        .sidebar .logo:hover img {
            transform: rotate(10deg) scale(1.1);
        }

        /* --- MENU LIST --- */
        .sidebar .menu {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 0;
            margin: 0;
            flex-grow: 1; /* Allows menu to take available space */
            overflow-y: auto; /* Scroll if menu is too tall */
            scrollbar-width: none; /* Hide scrollbar Firefox */
        }
        .sidebar .menu::-webkit-scrollbar { display: none; } /* Hide scrollbar Chrome */

        /* --- MENU LINKS --- */
        .sidebar .menu li a {
            text-decoration: none;
            color: #a0a0b0; /* Light Gray text (Fixes purple links) */
            font-family: 'Outfit', sans-serif;
            font-weight: 500;
            font-size: 1rem;
            display: flex;
            align-items: center;
            gap: 15px;
            padding: 12px 18px;
            border-radius: 12px;
            transition: all 0.3s ease;
            border: 1px solid transparent;
        }

        /* --- ICONS --- */
        .sidebar .menu li a i {
            width: 25px;
            text-align: center;
            font-size: 1.1rem;
            transition: 0.3s;
        }

        /* --- HOVER & ACTIVE STATES --- */
        .sidebar .menu li a:hover, 
        .sidebar .menu li a.active {
            background: rgba(0, 210, 255, 0.1);
            color: #ffffff;
            border-color: rgba(0, 210, 255, 0.3);
            box-shadow: 0 0 15px rgba(0, 210, 255, 0.15);
        }

        .sidebar .menu li a:hover i,
        .sidebar .menu li a.active i {
            color: #00d2ff;
            text-shadow: 0 0 10px #00d2ff;
        }

        /* --- LOGOUT BUTTON SPECIFIC --- */
        .menu-spacer { flex-grow: 1; } /* Pushes logout to bottom of the menu container */
        
        .logout {
            color: #ff4444 !important;
            margin-top: 10px;
        }
        .logout:hover {
            background: rgba(255, 68, 68, 0.1) !important;
            border-color: rgba(255, 68, 68, 0.3) !important;
            box-shadow: 0 0 15px rgba(255, 68, 68, 0.2) !important;
        }

        /* --- FOOTER / CREDITS --- */
        .sidebar-footer {
            margin-top: 20px;
            padding-top: 15px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            text-align: center;
            flex-shrink: 0;
            padding-bottom: env(safe-area-inset-bottom); /* Fix for iPhone home bar */
        }

        .sidebar-footer p {
            margin: 0;
            font-family: 'Outfit', sans-serif;
            font-size: 0.6rem; /* Reduced size */
            color: #ffffffff;
            line-height: 1.4;
        }

        .sidebar-footer a {
            color: #00d2ff;
            text-decoration: none;
            font-weight: 600;
            transition: 0.3s;
        }
        
        .sidebar-footer a:hover {
            text-shadow: 0 0 8px rgba(0, 210, 255, 0.6);
            color: #fff;
        }

        /* --- MOBILE STYLES --- */
        .mobile-header {
            display: none;
            position: fixed; top: 0; left: 0; width: 100%; height: 70px;
            background: rgba(10, 10, 20, 0.95); backdrop-filter: blur(15px);
            z-index: 9000;
            align-items: center; justify-content: space-between; padding: 0 20px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .mobile-logo { font-family: 'Rajdhani'; font-weight: 700; font-size: 1.5rem; color: white; }
        .menu-toggle { font-size: 1.5rem; color: #00d2ff; cursor: pointer; }
        .sidebar-overlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.7); backdrop-filter: blur(5px); z-index: 9500;
            opacity: 0; transition: opacity 0.3s;
        }

        /* Breakpoint */
        @media (max-width: 1024px) {
            .sidebar { transform: translateX(-100%); }
            .sidebar.active { transform: translateX(0); }
            .mobile-header { display: flex; }
        }
    `;
    document.head.appendChild(styleSheet);


    // --- 2. DEFINE & INJECT HTML ---
    const sidebarHTML = `
    <!-- Mobile Header -->
    <div class="mobile-header">
        <div class="mobile-logo">LAKSHYA 2K26</div>
        <i class="fa-solid fa-bars menu-toggle" onclick="toggleSidebar()"></i>
    </div>

    <!-- Background Overlay for Mobile -->
    <div class="sidebar-overlay" onclick="toggleSidebar()"></div>

    <!-- Sidebar Navigation -->
    <aside class="sidebar" id="sidebar">
        <!-- LOGO + TEXT UPDATE -->
        <div class="logo" onclick="window.location.href='/participant/dashboard'">
            <img src="/assets/logo.png" alt="Logo">
            <span>LAKSHYA</span>
        </div>
        
        <ul class="menu">
            <li><a href="/participant/dashboard" data-page="dashboard"><i class="fa-solid fa-gauge-high"></i> Dashboard</a></li>
            <li><a href="/participant/events" data-page="events"><i class="fa-solid fa-microchip"></i> Technical Events</a></li>
            <li><a href="/participant/culturals" data-page="culturals"><i class="fa-solid fa-music"></i> Rangamarthanda</a></li>
            <li><a href="/participant/cart" data-page="cart"><i class="fa-solid fa-cart-shopping"></i> My Cart</a></li>
            <li><a href="/participant/my-registrations" data-page="my-registrations"><i class="fa-solid fa-ticket"></i> Registrations</a></li>
            <li><a href="/participant/feedback" data-page="feedback"><i class="fa-solid fa-comment-dots"></i> Feedback</a></li>
            
            <li class="menu-spacer"></li>
            <li><a href="#" onclick="logout()" class="logout"><i class="fa-solid fa-power-off"></i> Logout</a></li>
        </ul>

        <!-- Credits Footer -->
        <div class="sidebar-footer">
            <p>
                Designed & Developed by 
                <a href="https://xetasolutions.in" target="_blank">Xeta</a>
            </p>
            <p style="margin-top: 3px; opacity: 0.7;">
                Start-up from Dept. of AI & DS, LBRCE
            </p>
        </div>
    </aside>
    `;

    // Inject immediately at the start of body
    document.body.insertAdjacentHTML('afterbegin', sidebarHTML);

    // --- 3. SET ACTIVE LINK AUTOMATICALLY ---
    if (typeof CURRENT_PAGE !== 'undefined') {
        const activeLink = document.querySelector(`.menu a[data-page="${CURRENT_PAGE}"]`);
        if (activeLink) activeLink.classList.add('active');
    }
});

// --- GLOBAL UTILITIES ---

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    
    sidebar.classList.toggle('active');
    
    if (sidebar.classList.contains('active')) {
        overlay.style.display = 'block';
        setTimeout(() => overlay.style.opacity = '1', 10);
    } else {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.style.display = 'none', 300);
    }
}

function logout() {
    if(confirm('Are you sure you want to secure logout?')) {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/login'; 
    }
}