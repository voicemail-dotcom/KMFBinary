// KMFBinary Application Core
// Demo version

console.log("KMFBinary loaded successfully");


// Highlight links that point to the current page

const currentPage =
    window.location.pathname.split("/").pop();

document.querySelectorAll("a").forEach(link => {

    const href = link.getAttribute("href");

    if (href === currentPage) {
        link.classList.add("active");
    }

});